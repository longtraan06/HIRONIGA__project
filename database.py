"""
Database Microservice (`src/apps/database.py`)

Standalone REST service providing vector similarity search, multimodal filtering (OCR/ASR/tags/events),
temporal sequence search, and database stats.

Entry point for `uv run database`:
  uv run database --host 0.0.0.0 --port 6090 --workers 1
"""

import os
import sys
import time
import argparse
import io
import json
import asyncio
from contextlib import asynccontextmanager
from functools import partial
from typing import List, Optional, Dict, Any, Union
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Depends, status, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from src.schemas import (
    BaseSearchRequest,
    TextToImageRequest,
    TextToTextRequest,
    TemporalStartRequest,
    TemporalContinueRequest,
    ASRSearchRequest,
    ASRSearchResponse
)

app = FastAPI(
    title="Database Microservice",
    version="1.0.0",
    description="Dedicated microservice exposing Milvus vector search, Elasticsearch text filtering, and temporal sequence search."
)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Milvus instance manager (lazy loaded)
milvus_instance = None


def get_milvus():
    global milvus_instance
    if milvus_instance is None:
        from src.core.database.milvus import MilvusManager

        config_path = os.getenv("DATABASE_CONFIG_PATH", "configs/database.yaml")
        print(f"[DB_SERVICE] Initializing MilvusManager using config '{config_path}'...")
        milvus_instance = MilvusManager.from_config(config_path=config_path)
    return milvus_instance


@app.on_event("startup")
async def startup_event():
    try:
        get_milvus()
    except Exception as e:
        print(f"[DB_SERVICE] Startup initialization failed: {e}")
        raise
    print(
        f"[DB_SERVICE] Ready with up to {MAX_CONCURRENT_SEARCHES} concurrent searches "
        f"and a {SEARCH_QUEUE_TIMEOUT:.1f}s queue timeout."
    )


@app.on_event("shutdown")
async def shutdown_event():
    global milvus_instance
    if milvus_instance:
        print("[DB_SERVICE] Closing Milvus connections...")
        milvus_instance.close()
        milvus_instance = None


# --- Response Schemas ---
class FrameResultHit(BaseModel):
    id: Optional[int] = None
    score: float = 0.0
    video_name: str
    frame_specify: str
    frame_name: Optional[str] = None
    frame_id: Optional[int] = None
    timestamp: float = 0.0
    ocr: Optional[str] = None
    asr: Optional[str] = None
    cluster_id: Optional[str] = None
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    temporal_score: Optional[float] = None
    original_score: Optional[float] = None
    sim_score: Optional[float] = None
    temporal_chain: Optional[Dict[str, Any]] = None


class SearchResponse(BaseModel):
    status: str
    query: str
    total_hits: int
    results: List[FrameResultHit]
    latency_ms: float


class TextFilterRequest(BaseModel):
    field: str = Field(description="'ocr' or 'asr'")
    query: str
    fuzzy: bool = False
    threshold: int = 85
    allowed_videos: Optional[List[str]] = None
    ocr_mode: str = "cascading"


class TextFilterResponse(BaseModel):
    status: str
    field: str
    backend: str
    filter_expression: Optional[str] = None
    latency_ms: float


MAX_CONCURRENT_SEARCHES = max(1, int(os.getenv("DATABASE_MAX_CONCURRENT_SEARCHES", "5")))
SEARCH_QUEUE_TIMEOUT = max(0.1, float(os.getenv("DATABASE_QUEUE_TIMEOUT", "3")))
_search_semaphore = asyncio.Semaphore(MAX_CONCURRENT_SEARCHES)
_temporal_locks = [asyncio.Lock() for _ in range(256)]


@asynccontextmanager
async def search_slot():
    try:
        await asyncio.wait_for(_search_semaphore.acquire(), timeout=SEARCH_QUEUE_TIMEOUT)
    except asyncio.TimeoutError as error:
        raise HTTPException(
            status_code=503,
            detail="Database search capacity is currently full. Please retry shortly.",
            headers={"Retry-After": "1"},
        ) from error
    try:
        yield
    finally:
        _search_semaphore.release()


async def run_blocking_search(func, /, *args, **kwargs):
    async with search_slot():
        return await run_in_threadpool(partial(func, *args, **kwargs))


def temporal_lock(user_id: str) -> asyncio.Lock:
    return _temporal_locks[hash(user_id) % len(_temporal_locks)]


def serialize_frame_hits(raw_hits: list) -> list[FrameResultHit]:
    results = []
    for hit in raw_hits:
        metadata = hit.get("metadata") or {}
        video_name = hit.get("video_name") or metadata.get("video_name", "")
        frame_specify = hit.get("frame_specify") or metadata.get("frame_specify", "")
        if not video_name and "/" in frame_specify:
            video_name = frame_specify.split("/", 1)[0]

        frame_id = hit.get("frame_id")
        if frame_id is None:
            frame_id = metadata.get("frame_id")
        timestamp = hit.get("timestamp")
        if timestamp is None:
            timestamp = metadata.get("timestamp", 0.0)

        results.append(FrameResultHit(
            id=hit.get("id"),
            score=float(hit.get("score", hit.get("temporal_score", hit.get("original_score", 0.0)))),
            video_name=video_name,
            frame_specify=frame_specify,
            frame_name=hit.get("frame_name") or metadata.get("frame_name"),
            frame_id=frame_id,
            timestamp=float(timestamp or 0.0),
            ocr=hit.get("ocr") or metadata.get("ocr"),
            asr=hit.get("asr") or metadata.get("asr"),
            cluster_id=hit.get("cluster_id") or metadata.get("cluster_id"),
            tags=hit.get("tags") or metadata.get("tags"),
            metadata=metadata or None,
            temporal_score=hit.get("temporal_score"),
            original_score=hit.get("original_score"),
            sim_score=hit.get("sim_score"),
            temporal_chain=hit.get("temporal_chain"),
        ))
    return results


# --- API Routes ---

@app.get("/health")
def health_check():
    mgr = get_milvus()
    return {
        "status": "healthy",
        "milvus_connected": mgr is not None,
        "models": mgr.model_names if mgr else [],
        "es_host": mgr.es_host if mgr else None
    }


@app.post("/v1/search/text", response_model=SearchResponse)
async def search_text(req: BaseSearchRequest):
    """
    Multimodal text query search (text prompt -> top-K frames with OCR/ASR/tag/cluster filters).
    Supports temporal context continuation if user_id and query_id are provided.
    """
    t0 = time.time()
    mgr = get_milvus()
    try:
        raw_hits = await run_blocking_search(
            mgr.search,
            query=req.query,
            mode="text",
            search_in=req.search_in,
            top_k=req.top_k,
            model_name=req.model_name,
            ocr=req.ocr,
            ocr_mode=req.ocr_mode,
            ocr_fuzzy=req.ocr_fuzzy,
            asr=req.asr,
            asr_mode=req.asr_mode,
            asr_top_k=req.asr_top_k,
            asr_fuzzy=req.asr_fuzzy,
            tags_filter=req.tags_filter,
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            use_event_filter=req.use_event_filter,
            user_filter=req.user_filter,
            cluster_ids=req.cluster_ids,
            cluster_mode_enabled=req.cluster_mode_enabled,
            user_id=req.user_id,
            query_id=req.query_id
        )

        results = serialize_frame_hits(raw_hits)

        latency = round((time.time() - t0) * 1000, 2)
        return SearchResponse(
            status="success",
            query=req.query,
            total_hits=len(results),
            results=results,
            latency_ms=latency
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Text search error: {str(e)}")


@app.post("/v1/search/image", response_model=SearchResponse)
async def search_image(
    file: UploadFile = File(...),
    top_k: int = Form(650),
    model_name: Optional[str] = Form(None),
    use_tag: bool = Form(False),
    top_k_tags: int = Form(5),
    use_event_filter: bool = Form(False),
    user_filter: Optional[List[str]] = Form(None),
    cluster_mode_enabled: bool = Form(True)
):
    """
    Visual similarity search using an uploaded image file.
    """
    from PIL import Image

    t0 = time.time()
    mgr = get_milvus()
    try:
        contents = await file.read()

        def execute_image_search():
            with Image.open(io.BytesIO(contents)) as image:
                return mgr.search(
                    query=image.convert("RGB"),
                    mode="image",
                    search_in="image",
                    top_k=top_k,
                    model_name=model_name,
                    use_tag=use_tag,
                    top_k_tags=top_k_tags,
                    use_event_filter=use_event_filter,
                    user_filter=user_filter,
                    cluster_mode_enabled=cluster_mode_enabled,
                )

        raw_hits = await run_blocking_search(execute_image_search)

        results = serialize_frame_hits(raw_hits)

        latency = round((time.time() - t0) * 1000, 2)
        return SearchResponse(
            status="success",
            query=file.filename or "uploaded_image",
            total_hits=len(results),
            results=results,
            latency_ms=latency
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image search error: {str(e)}")


@app.post("/v1/search/temporal/start")
async def temporal_search_start(req: TemporalStartRequest):
    """
    Initializes a new temporal sequence search chain for a user.
    """
    t0 = time.time()
    mgr = get_milvus()
    if not req.user_id or not req.query_id:
        raise HTTPException(status_code=400, detail="user_id and query_id are required for temporal start.")

    try:
        async with temporal_lock(req.user_id):
            raw_hits = await run_blocking_search(
                mgr.search,
                query=req.query,
                mode="text",
                search_in="image",
                top_k=req.top_k,
                model_name=req.model_name,
                start_temporal_chain=True,
                user_id=req.user_id,
                query_id=req.query_id,
                use_tag=req.use_tag,
                top_k_tags=req.top_k_tags,
                tags_filter=req.tags_filter,
                ocr=req.ocr,
                ocr_mode=req.ocr_mode,
                asr=req.asr,
                asr_mode=req.asr_mode,
                asr_top_k=req.asr_top_k,
                use_event_filter=req.use_event_filter,
                ocr_fuzzy=req.ocr_fuzzy,
                asr_fuzzy=req.asr_fuzzy,
                user_filter=req.user_filter or req.cluster_ids,
                cluster_mode_enabled=req.cluster_mode_enabled,
            )
        results = serialize_frame_hits(raw_hits)
        latency = round((time.time() - t0) * 1000, 2)
        return {
            "status": "success",
            "user_id": req.user_id,
            "query_id": req.query_id,
            "total_hits": len(results),
            "results": [r.dict() for r in results],
            "latency_ms": latency
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Temporal start error: {str(e)}")


@app.post("/v1/search/temporal/continue")
async def temporal_search_continue(req: TemporalContinueRequest):
    """
    Continues or updates an existing query in the user's temporal search sequence chain.
    """
    t0 = time.time()
    mgr = get_milvus()
    if not req.user_id or not req.query_id:
        raise HTTPException(status_code=400, detail="user_id and query_id are required for temporal continue.")

    try:
        async with temporal_lock(req.user_id):
            res = await run_blocking_search(
                mgr.temporal_search_sequence,
                query=req.query,
                user_id=req.user_id,
                query_id=req.query_id,
                mode="text",
                search_in="image",
                top_k=req.top_k,
                model_name=req.model_name,
                use_tag=req.use_tag,
                top_k_tags=req.top_k_tags,
                tags_filter=req.tags_filter,
                ocr=req.ocr,
                ocr_mode=req.ocr_mode,
                asr=req.asr,
                asr_mode=req.asr_mode,
                asr_top_k=req.asr_top_k,
                use_event_filter=req.use_event_filter,
                ocr_fuzzy=req.ocr_fuzzy,
                asr_fuzzy=req.asr_fuzzy,
                user_filter=req.user_filter or req.cluster_ids,
                cluster_mode_enabled=req.cluster_mode_enabled,
            )
        latency = round((time.time() - t0) * 1000, 2)
        return {
            "status": "success",
            "user_id": req.user_id,
            "query_id": req.query_id,
            "data": res,
            "latency_ms": latency
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Temporal continue error: {str(e)}")


@app.post("/v1/filter/text", response_model=TextFilterResponse)
def text_filter_expression(req: TextFilterRequest):
    """
    Generates filter expressions for OCR or ASR text queries.
    """
    from src.core.database.text_filters import get_text_filter_backend

    t0 = time.time()
    mgr = get_milvus()
    try:
        backend = get_text_filter_backend(mgr, field=req.field, fuzzy=req.fuzzy)
        expr_result = backend.filter(
            field=req.field,
            query=req.query,
            fuzzy=req.fuzzy,
            threshold=req.threshold,
            allowed_videos=req.allowed_videos,
            ocr_mode=req.ocr_mode
        )

        filter_expr = None
        if isinstance(expr_result, list):
            if not expr_result:
                filter_expr = "id in [-1]"
            elif all(isinstance(x, int) for x in expr_result):
                filter_expr = f"id in {json.dumps(expr_result)}"
            else:
                sanitized = [str(p).replace('\\', '\\\\').replace('"', '\\"') for p in expr_result]
                filter_expr = f'frame_specify in ["' + '", "'.join(sanitized) + '"]'
        else:
            filter_expr = expr_result

        latency = round((time.time() - t0) * 1000, 2)
        return TextFilterResponse(
            status="success",
            field=req.field,
            backend=backend.__class__.__name__,
            filter_expression=filter_expr,
            latency_ms=latency
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Text filter error: {str(e)}")


@app.get("/v1/collection/stats")
def collection_stats():
    """
    Returns total entity counts for all loaded Milvus model collections.
    """
    mgr = get_milvus()
    stats = {}
    for model_name in mgr.model_names:
        collection = mgr.collections.get(model_name)
        stats[model_name] = {
            "collection_name": collection.name if collection else None,
            "num_entities": collection.num_entities if collection else 0
        }
    return {"status": "success", "stats": stats}


@app.get("/v1/models")
def get_available_models():
    """
    Returns list of loaded model names.
    """
    mgr = get_milvus()
    return {"models": getattr(mgr, "model_names", ["google/siglip2-large-patch16-512"])}


@app.get("/v1/asr_transcript")
def get_asr_transcript(
    frame_specify: Optional[str] = Query(None),
    video_name: Optional[str] = Query(None),
    timestamp: Optional[float] = Query(None),
    frame_id: Optional[int] = Query(None),
    video_id: Optional[str] = Query(None),
    time_stamp: Optional[float] = Query(None),
    model_name: Optional[str] = Query(None),
):
    """
    Fetches ASR transcript details for a frame or video timestamp.
    """
    mgr = get_milvus()
    try:
        res = mgr.get_asr_transcript_for_frame(
            frame_specify=frame_specify,
            video_name=video_name or video_id,
            timestamp=timestamp if timestamp is not None else time_stamp,
            frame_id=frame_id,
            model_name=model_name,
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ASR transcript fetch error: {str(e)}")


@app.get("/v1/ocr_text")
def get_ocr_text(
    frame_specify: Optional[str] = Query(None),
    video_name: Optional[str] = Query(None),
    timestamp: Optional[float] = Query(None),
    frame_id: Optional[int] = Query(None),
    video_id: Optional[str] = Query(None),
    time_stamp: Optional[float] = Query(None),
    model_name: Optional[str] = Query(None),
):
    """
    Fetches OCR text recognized on a specific frame.
    """
    mgr = get_milvus()
    try:
        res = mgr.get_ocr_text_for_frame(
            frame_specify=frame_specify,
            video_name=video_name or video_id,
            timestamp=timestamp if timestamp is not None else time_stamp,
            frame_id=frame_id,
            model_name=model_name,
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR text fetch error: {str(e)}")


@app.get("/v1/frame_text")
def get_frame_text(
    frame_specify: Optional[str] = Query(None),
    video_name: Optional[str] = Query(None),
    timestamp: Optional[float] = Query(None),
    frame_id: Optional[int] = Query(None),
    video_id: Optional[str] = Query(None),
    time_stamp: Optional[float] = Query(None),
    model_name: Optional[str] = Query(None),
):
    """
    Fetches both ASR transcript and OCR text for a specific frame.
    """
    mgr = get_milvus()
    try:
        target_vid = video_name or video_id
        target_ts = timestamp if timestamp is not None else time_stamp
        asr_data = mgr.get_asr_transcript_for_frame(
            frame_specify=frame_specify,
            video_name=target_vid,
            timestamp=target_ts,
            frame_id=frame_id,
            model_name=model_name,
        )
        ocr_data = mgr.get_ocr_text_for_frame(
            frame_specify=frame_specify,
            video_name=target_vid,
            timestamp=target_ts,
            frame_id=frame_id,
            model_name=model_name,
        )
        return {
            "frame_id": frame_id or asr_data.get("frame_id") or ocr_data.get("frame_id"),
            "frame_specify": frame_specify or ocr_data.get("frame_specify") or asr_data.get("frame_specify"),
            "video_name": target_vid or asr_data.get("video_name"),
            "timestamp": target_ts if target_ts is not None else asr_data.get("timestamp"),
            "asr": asr_data,
            "ocr": ocr_data,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Frame text fetch error: {str(e)}")


@app.get("/v1/temporal-chain/{user_id}/{frame_identifier:path}")
async def get_temporal_chain(user_id: str, frame_identifier: str):
    """
    Fetches temporal chain for a frame.
    """
    mgr = get_milvus()
    try:
        async with temporal_lock(user_id):
            chain_data = await run_in_threadpool(
                mgr.get_temporal_chain_for_frame,
                user_id,
                frame_identifier,
            )
        if not chain_data:
            return {"status": "not_found", "message": "Frame not in active chain or chain expired", "chain": []}
        return {"status": "success", "user_id": user_id, "frame": frame_identifier, "chain": chain_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Temporal chain fetch error: {str(e)}")


@app.delete("/v1/temporal-chain/{user_id}")
async def clear_temporal_chain(user_id: str):
    """
    Clears temporal chain for a user.
    """
    mgr = get_milvus()
    try:
        async with temporal_lock(user_id):
            await run_in_threadpool(partial(mgr.clear_temporal_chain, user_id=user_id))
        return {"status": "success", "message": f"Cleared temporal chain for user {user_id}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clear temporal chain error: {str(e)}")


@app.post("/v1/search/temporal/start_with_image")
async def temporal_search_start_with_image(
    file: UploadFile = File(...),
    top_k: int = Form(650),
    user_id: str = Form(...),
    query_id: str = Form(...),
    model_name: Optional[str] = Form(None),
    use_event_filter: bool = Form(False),
    user_filter: Optional[List[str]] = Form(None),
    cluster_mode_enabled: bool = Form(True),
):
    """
    Initializes a new temporal sequence search chain using an image.
    """
    from PIL import Image

    t0 = time.time()
    mgr = get_milvus()
    try:
        contents = await file.read()
        async with temporal_lock(user_id):
            def execute_temporal_image_search():
                with Image.open(io.BytesIO(contents)) as image:
                    return mgr.search(
                        query=image.convert("RGB"),
                        mode="image",
                        search_in="image",
                        top_k=top_k,
                        model_name=model_name,
                        start_temporal_chain=True,
                        user_id=user_id,
                        query_id=query_id,
                        use_event_filter=use_event_filter,
                        user_filter=user_filter,
                        cluster_mode_enabled=cluster_mode_enabled,
                    )

            raw_hits = await run_blocking_search(execute_temporal_image_search)
        results = serialize_frame_hits(raw_hits)
        latency = round((time.time() - t0) * 1000, 2)
        return {
            "status": "success",
            "user_id": user_id,
            "query_id": query_id,
            "total_hits": len(results),
            "results": [r.dict() for r in results],
            "latency_ms": latency,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Temporal start with image error: {str(e)}")


@app.post("/v1/search/asr", response_model=ASRSearchResponse)
async def search_asr(req: ASRSearchRequest):
    """
    Dense vector search for ASR embedding to find the single most suitable segment for a query and video/time range.
    """
    mgr = get_milvus()
    try:
        res = await run_blocking_search(
            mgr.search_asr,
            query=req.query,
            video_name=req.video_name,
            start_time=req.start_time,
            end_time=req.end_time,
            model_name=req.model_name
        )
        return ASRSearchResponse(**res)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ASR search error: {str(e)}")



# --- CLI Entry Point ---

def main():
    parser = argparse.ArgumentParser(description="Launch Database Microservice Server")
    parser.add_argument("--config", "--config-path", type=str, default="configs/database.yaml", help="Path to database YAML config file")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host address to bind server")
    parser.add_argument("--port", type=int, default=6090, help="Port number to listen on")
    parser.add_argument("--workers", type=int, default=1, help="Number of worker processes")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload on code modifications")

    args, unknown = parser.parse_known_args()
    if args.workers != 1:
        parser.error("Database Microservice currently requires --workers 1 because temporal state is process-local.")
    os.environ["DATABASE_CONFIG_PATH"] = args.config

    import uvicorn
    print(f"[DB_SERVICE] Launching server on http://{args.host}:{args.port} using config '{args.config}' (workers={args.workers})...")
    uvicorn.run("src.apps.database:app", host=args.host, port=args.port, workers=args.workers, reload=args.reload)


if __name__ == "__main__":
    main()
