from fastapi import FastAPI, UploadFile, File, Form, Request, Response, HTTPException, Depends, Query, status, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from typing import Any, Dict, List, Literal, Optional
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from functools import lru_cache, wraps
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from PIL import Image
import os
import re
import csv
import time
import uuid
import json
import hashlib
import secrets
import traceback
import zipfile
try:
    import redis.asyncio as aioredis
except ImportError:
    import aioredis
import asyncio
import fcntl
import io
import urllib.parse
import httpx
from bisect import bisect_right
from contextlib import contextmanager
from pathlib import Path
FORM_SUBMIT_SAVE_PATH = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/backend/csv_submit"

PROJECT_DIR = Path(__file__).resolve().parent
CLUSTER_CATALOG_FILE = Path("/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/core/clustering/hcm_noisy_frame_clustering/outputs/kmeans_image_k1000/clusters.json")
CLUSTER_DELETION_FILE = Path("/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/backend/Clustered/deleted_clusters.json")
ASR_TRANSCRIPT_FILE = Path("/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/core/asr/outputs/qwen3_asr_20s/transcripts_timestamped.json")


DEFAULT_DATABASE_MODEL = "google/siglip2-large-patch16-512"


class DatabaseServiceError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class DatabaseServiceClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0),
            limits=httpx.Limits(
                max_keepalive_connections=16,
                max_connections=32,
                keepalive_expiry=30.0,
            ),
            headers={"Accept-Encoding": "identity"},
        )

    async def _request_json(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as error:
            raise DatabaseServiceError(f"Database service timed out: {error}", 504) from error
        except httpx.RequestError as error:
            raise DatabaseServiceError(f"Database service is unavailable: {error}", 502) from error

        if response.is_error:
            if response.status_code in {503, 504}:
                gateway_status = response.status_code
            elif response.status_code < 500:
                gateway_status = response.status_code
            else:
                gateway_status = 502
            raise DatabaseServiceError(
                f"Database service returned {response.status_code}: {response.text[:500]}",
                gateway_status,
            )

        try:
            payload = response.json()
        except ValueError as error:
            raise DatabaseServiceError("Database service returned invalid JSON.", 502) from error
        if not isinstance(payload, dict):
            raise DatabaseServiceError("Database service returned an invalid response shape.", 502)
        return payload

    async def health_check(self) -> dict:
        return await self._request_json("GET", "/health")

    async def get_model_names(self) -> list:
        payload = await self._request_json("GET", "/v1/models")
        models = payload.get("models")
        return models if isinstance(models, list) and models else [DEFAULT_DATABASE_MODEL]

    @staticmethod
    def _image_bytes(query: Any) -> bytes:
        if isinstance(query, bytes):
            return query
        if hasattr(query, "save"):
            buffer = io.BytesIO()
            query.save(buffer, format="PNG")
            return buffer.getvalue()
        return bytes(query)

    @staticmethod
    def _format_hits(raw_hits: list) -> list:
        formatted = []
        for raw_hit in raw_hits:
            hit = dict(raw_hit)
            metadata = dict(hit.get("metadata") or {})
            frame_specify = hit.get("frame_specify") or metadata.get("frame_specify", "")
            video_name = hit.get("video_name") or metadata.get("video_name", "")
            if not video_name and "/" in frame_specify:
                video_name = frame_specify.split("/", 1)[0]
            frame_name = hit.get("frame_name") or metadata.get("frame_name")
            if not frame_name and "/" in frame_specify:
                frame_name = frame_specify.rsplit("/", 1)[1]

            metadata.update({
                "video_name": video_name,
                "frame_specify": frame_specify,
                "frame_name": frame_name or "",
                "frame_id": hit.get("frame_id") if hit.get("frame_id") is not None else metadata.get("frame_id", 0),
                "timestamp": hit.get("timestamp") if hit.get("timestamp") is not None else metadata.get("timestamp", 0.0),
                "ocr": hit.get("ocr") or metadata.get("ocr", ""),
                "asr": hit.get("asr") or metadata.get("asr", ""),
                "cluster_id": hit.get("cluster_id") or metadata.get("cluster_id", ""),
                "tags": hit.get("tags") or metadata.get("tags", []),
            })
            hit["metadata"] = metadata
            formatted.append(hit)
        return formatted

    async def search(
        self,
        query: Any,
        mode: str = "text",
        search_in: str = "image",
        top_k: int = 650,
        model_name: Optional[str] = None,
        use_tag: bool = False,
        top_k_tags: int = 5,
        tags_filter: Optional[List[str]] = None,
        ocr: Optional[str] = None,
        ocr_mode: str = "cascading",
        asr: Optional[str] = None,
        asr_mode: str = "keyword",
        asr_top_k: Optional[int] = None,
        use_event_filter: bool = False,
        ocr_fuzzy: bool = False,
        asr_fuzzy: bool = False,
        user_filter: Optional[List[str]] = None,
        start_temporal_chain: bool = False,
        user_id: Optional[str] = None,
        query_id: Optional[str] = None,
        cluster_mode_enabled: bool = True,
        **kwargs,
    ) -> list:
        if mode == "image":
            data = {
                "top_k": str(top_k),
                "use_event_filter": str(use_event_filter).lower(),
                "user_filter": user_filter or [],
                "cluster_mode_enabled": str(cluster_mode_enabled).lower(),
            }
            if model_name is not None:
                data["model_name"] = model_name
            if start_temporal_chain:
                data.update({"user_id": user_id or "", "query_id": query_id or ""})
                endpoint = "/v1/search/temporal/start_with_image"
            else:
                data.update({
                    "use_tag": str(use_tag).lower(),
                    "top_k_tags": str(top_k_tags),
                })
                endpoint = "/v1/search/image"
            payload = await self._request_json(
                "POST",
                endpoint,
                data=data,
                files={"file": ("query_image.png", self._image_bytes(query), "image/png")},
            )
            return self._format_hits(payload.get("results", []))

        payload_request = {
            "query": str(query),
            "search_in": search_in,
            "top_k": top_k,
            "model_name": model_name,
            "use_tag": use_tag,
            "top_k_tags": top_k_tags,
            "tags_filter": tags_filter,
            "ocr": ocr,
            "ocr_mode": ocr_mode,
            "asr": asr,
            "asr_mode": asr_mode,
            "asr_top_k": asr_top_k,
            "use_event_filter": use_event_filter,
            "ocr_fuzzy": ocr_fuzzy,
            "asr_fuzzy": asr_fuzzy,
            "user_filter": user_filter or [],
            "cluster_mode_enabled": cluster_mode_enabled,
            "user_id": user_id,
            "query_id": query_id,
        }
        endpoint = "/v1/search/temporal/start" if start_temporal_chain else "/v1/search/text"
        payload = await self._request_json("POST", endpoint, json=payload_request)
        return self._format_hits(payload.get("results", []))

    async def temporal_search_sequence(
        self,
        query: str,
        user_id: str,
        query_id: str,
        mode: str = "text",
        top_k: int = 500,
        model_name: Optional[str] = None,
        use_tag: bool = False,
        top_k_tags: int = 5,
        tags_filter: Optional[List[str]] = None,
        ocr: Optional[str] = None,
        ocr_mode: str = "cascading",
        asr: Optional[str] = None,
        asr_mode: str = "keyword",
        asr_top_k: Optional[int] = None,
        use_event_filter: bool = False,
        ocr_fuzzy: bool = False,
        asr_fuzzy: bool = False,
        user_filter: Optional[List[str]] = None,
        cluster_mode_enabled: bool = True,
        **kwargs,
    ) -> dict:
        payload_request = {
            "query": query,
            "chain_id": user_id,
            "user_id": user_id,
            "query_id": query_id,
            "search_in": "image",
            "top_k": top_k,
            "model_name": model_name,
            "use_tag": use_tag,
            "top_k_tags": top_k_tags,
            "tags_filter": tags_filter,
            "ocr": ocr,
            "ocr_mode": ocr_mode,
            "asr": asr,
            "asr_mode": asr_mode,
            "asr_top_k": asr_top_k,
            "use_event_filter": use_event_filter,
            "ocr_fuzzy": ocr_fuzzy,
            "asr_fuzzy": asr_fuzzy,
            "user_filter": user_filter or [],
            "cluster_mode_enabled": cluster_mode_enabled,
        }
        payload = await self._request_json("POST", "/v1/search/temporal/continue", json=payload_request)
        data = payload.get("data", {})
        if not isinstance(data, dict):
            raise DatabaseServiceError("Database service returned invalid temporal data.", 502)
        if isinstance(data.get("query_A_reranked"), list):
            data["query_A_reranked"] = self._format_hits(data["query_A_reranked"])
        return data

    async def temporal_search_sequence_with_image(
        self,
        query: Any,
        user_id: str,
        query_id: str,
        top_k: int = 500,
        model_name: Optional[str] = None,
        use_event_filter: bool = False,
        user_filter: Optional[List[str]] = None,
        cluster_mode_enabled: bool = True,
    ) -> dict:
        data = {
            "user_id": user_id,
            "query_id": query_id,
            "top_k": str(top_k),
            "use_event_filter": str(use_event_filter).lower(),
            "cluster_mode_enabled": str(cluster_mode_enabled).lower(),
        }
        if model_name is not None:
            data["model_name"] = model_name
        if user_filter:
            data["user_filter"] = user_filter

        payload = await self._request_json(
            "POST",
            "/v1/search/temporal/continue_with_image",
            data=data,
            files={"file": ("temporal-query-image.png", self._image_bytes(query), "image/png")},
        )
        temporal_data = payload.get("data", {})
        if not isinstance(temporal_data, dict):
            raise DatabaseServiceError("Database service returned invalid temporal image data.", 502)
        if isinstance(temporal_data.get("query_A_reranked"), list):
            temporal_data["query_A_reranked"] = self._format_hits(temporal_data["query_A_reranked"])
        return temporal_data

    async def get_asr_transcript_for_frame(self, **params) -> dict:
        clean_params = {key: value for key, value in params.items() if value is not None}
        return await self._request_json("GET", "/v1/asr_transcript", params=clean_params)

    async def get_ocr_text_for_frame(self, **params) -> dict:
        clean_params = {key: value for key, value in params.items() if value is not None}
        return await self._request_json("GET", "/v1/ocr_text", params=clean_params)

    async def get_temporal_chain_for_frame(self, user_id: str, frame_identifier: str) -> dict:
        encoded_frame = urllib.parse.quote(frame_identifier, safe="")
        payload = await self._request_json("GET", f"/v1/temporal-chain/{user_id}/{encoded_frame}")
        return payload.get("chain", {})

    async def clear_temporal_chain(self, user_id: str) -> bool:
        await self._request_json("DELETE", f"/v1/temporal-chain/{user_id}")
        return True

    async def aclose(self):
        await self._client.aclose()


class TranscriptStore:
    def __init__(self, path: Path):
        self.path = path
        self.videos: Dict[str, dict] = {}
        self.etag = None
        self.error = None
        self._load()

    @staticmethod
    def _timestamp_to_seconds(value: str) -> float:
        parts = value.strip().split(":")
        if len(parts) != 3:
            raise ValueError(f"Invalid transcript timestamp: {value}")
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])

    def _load(self):
        try:
            with self.path.open("r", encoding="utf-8") as file:
                raw_transcripts = json.load(file)

            videos = {}
            for source_name, raw_segments in raw_transcripts.items():
                if not isinstance(raw_segments, dict):
                    continue
                video_name = re.sub(r"\.(?:wav|mp3|mp4)$", "", source_name, flags=re.IGNORECASE)
                segments = []
                for time_range, text in raw_segments.items():
                    if not isinstance(time_range, str) or not isinstance(text, str):
                        continue
                    labels = [label.strip() for label in time_range.split("-->", 1)]
                    if len(labels) != 2:
                        continue
                    try:
                        start = self._timestamp_to_seconds(labels[0])
                        end = self._timestamp_to_seconds(labels[1])
                    except (TypeError, ValueError):
                        continue
                    segments.append({
                        "start": start,
                        "end": end,
                        "start_label": labels[0],
                        "end_label": labels[1],
                        "text": text,
                    })
                segments.sort(key=lambda segment: (segment["start"], segment["end"]))
                videos[video_name] = {
                    "video_name": video_name,
                    "segments": segments,
                }

            stat = self.path.stat()
            self.videos = videos
            self.etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
            self.error = None
            print(f"Loaded transcripts for {len(videos)} videos from {self.path}")
        except Exception as error:
            self.videos = {}
            self.etag = None
            self.error = str(error)
            print(f"Transcript data unavailable at {self.path}: {error}")

    def get(self, video_name: str) -> Optional[dict]:
        normalized_name = re.sub(r"\.(?:wav|mp3|mp4)$", "", video_name, flags=re.IGNORECASE)
        return self.videos.get(normalized_name)


class ClusterCatalog:
    """In-memory lookup indexes for the static cluster export."""

    def __init__(self, path: Path):
        self.path = path
        self.clusters = {}
        self.frame_to_cluster = {}
        self._load()

    def _load(self):
        if not self.path.is_file():
            raise RuntimeError(f"Cluster catalog not found: {self.path}")

        with self.path.open("r", encoding="utf-8") as file:
            raw_catalog = json.load(file)

        for raw_cluster in raw_catalog.get("clusters", []):
            cluster_id = str(raw_cluster.get("cluster_id", ""))
            if not cluster_id:
                continue

            frames = []
            for raw_frame in raw_cluster.get("frames", []):
                video_name = raw_frame.get("video_name")
                frame_name = raw_frame.get("frame_name")
                frame_specify = raw_frame.get("frame_specify") or (
                    f"{video_name}/{frame_name}" if video_name and frame_name else ""
                )
                if not frame_specify or not video_name or not frame_name:
                    continue

                frame = {
                    "frame_specify": frame_specify,
                    "video_name": video_name,
                    "frame_name": frame_name,
                    "frame_id": raw_frame.get("frame_id"),
                    "timestamp": raw_frame.get("timestamp"),
                }
                frames.append(frame)
                self.frame_to_cluster[frame_specify] = cluster_id

            if frames:
                self.clusters[cluster_id] = {
                    "cluster_id": cluster_id,
                    "count": raw_cluster.get("count", len(frames)),
                    "frames": frames,
                }

        print(
            f"Loaded {len(self.clusters)} clusters and "
            f"{len(self.frame_to_cluster)} frame assignments from {self.path}"
        )

    @staticmethod
    def _frame_payload(frame: dict) -> dict:
        frame_name = frame["frame_name"]
        full_frame_name = frame_name if frame_name.endswith(".webp") else f"{frame_name}.webp"
        return {
            **frame,
            "path": f"/frames/{frame['video_name']}/{full_frame_name}",
        }

    def resolve_frame(self, frame_specify: str) -> dict | None:
        cluster_id = self.frame_to_cluster.get(frame_specify)
        if cluster_id is None:
            return None
        cluster = self.clusters[cluster_id]
        return {
            "cluster_id": cluster_id,
            "count": cluster["count"],
            "representative": self._frame_payload(cluster["frames"][0]),
        }

    def get_cluster(self, cluster_id: str) -> dict | None:
        cluster = self.clusters.get(str(cluster_id))
        if cluster is None:
            return None
        return {
            "cluster_id": cluster["cluster_id"],
            "count": cluster["count"],
            "representative": self._frame_payload(cluster["frames"][0]),
            "frames": [self._frame_payload(frame) for frame in cluster["frames"]],
        }

    def deleted_summaries(self, cluster_ids: list[str]) -> list[dict]:
        summaries = []
        for cluster_id in cluster_ids:
            cluster = self.get_cluster(cluster_id)
            if cluster is None:
                continue
            summaries.append({
                "cluster_id": cluster["cluster_id"],
                "count": cluster["count"],
                "representative": cluster["representative"],
            })
        return summaries


class ClusterDeletionStore:
    """A process-safe, persistent list of globally excluded cluster IDs."""

    def __init__(self, path: Path):
        self.path = path
        self.lock_path = path.with_suffix(f"{path.suffix}.lock")

    @contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _read_unlocked(self) -> list[str]:
        if not self.path.is_file():
            return []
        try:
            with self.path.open("r", encoding="utf-8") as file:
                payload = json.load(file)
        except (OSError, json.JSONDecodeError):
            return []

        cluster_ids = payload.get("cluster_ids", []) if isinstance(payload, dict) else []
        seen = set()
        normalized_ids = []
        for raw_id in cluster_ids:
            cluster_id = str(raw_id)
            if cluster_id and cluster_id not in seen:
                seen.add(cluster_id)
                normalized_ids.append(cluster_id)
        return normalized_ids

    def _write_unlocked(self, cluster_ids: list[str]):
        temporary_path = self.path.with_suffix(f"{self.path.suffix}.tmp")
        with temporary_path.open("w", encoding="utf-8") as file:
            json.dump({"version": 1, "cluster_ids": cluster_ids}, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, self.path)

    def list_ids(self) -> list[str]:
        with self._locked():
            return self._read_unlocked()

    def add(self, cluster_id: str) -> tuple[bool, list[str]]:
        with self._locked():
            cluster_ids = self._read_unlocked()
            if cluster_id in cluster_ids:
                return False, cluster_ids
            cluster_ids.append(cluster_id)
            self._write_unlocked(cluster_ids)
            return True, cluster_ids

    def remove(self, cluster_id: str) -> tuple[bool, list[str]]:
        with self._locked():
            cluster_ids = self._read_unlocked()
            if cluster_id not in cluster_ids:
                return False, cluster_ids
            cluster_ids.remove(cluster_id)
            self._write_unlocked(cluster_ids)
            return True, cluster_ids


cluster_catalog = ClusterCatalog(CLUSTER_CATALOG_FILE)
cluster_deletion_store = ClusterDeletionStore(CLUSTER_DELETION_FILE)
transcript_store = TranscriptStore(ASR_TRANSCRIPT_FILE)


def get_search_cluster_filter(cluster_mode_enabled: bool) -> list[str]:
    return cluster_deletion_store.list_ids() if cluster_mode_enabled else []

app = FastAPI()
# Kết nối Redis

allowed_origin_regex = (
    r"^(?:"
    r"https?://(?:localhost|127\.0\.0\.1|192\.168\.(?:0|20)\.\d{1,3})(?::\d+)?"
    r"|https://aic\.mealsretrieval\.site"
    r")$"
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=allowed_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

REDIS_URL = "redis://192.168.20.156:6060"
redis_async_client = aioredis.from_url(REDIS_URL, decode_responses=True)
keysframe_path_root = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/frames"
video_path_root = "/mlcv1/Datasets/HCMAI25/full"
hls_path = "/mlcv1/Datasets/HCMAI25/streaming/hls/"
#hls_path = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/video_480p/" # encoded 480p

"""
Available models:
"google/siglip2-large-patch16-512"
"google/siglip2-so400m-patch16-512"
"google/siglip2-so400m-patch16-naflex"
"google/siglip2-giant-opt-patch16-384"
"""

def resolve_database_service_url() -> str:
    for i, arg in enumerate(sys.argv):
        if arg in ("--database-url", "--db-url") and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        elif arg.startswith("--database-url="):
            return arg.split("=", 1)[1]
        elif arg.startswith("--db-url="):
            return arg.split("=", 1)[1]
    return os.getenv("DATABASE_SERVICE_URL", "http://127.0.0.1:6090")

database_service_url = resolve_database_service_url()
milvus: Optional[DatabaseServiceClient] = None


# clear cache method

# Thêm xác thực cơ bản
security = HTTPBasic()

# Thông tin đăng nhập admin (thay đổi thành thông tin của bạn)
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "hlgay"  # Thay đổi mật khẩu này!

@app.on_event("startup")
async def startup_event():
    global milvus
    milvus = DatabaseServiceClient(database_service_url)
    try:
        health = await milvus.health_check()
    except Exception:
        await milvus.aclose()
        milvus = None
        raise
    print(
        f"[API_SERVER_SERVICE] Connected to database service at '{database_service_url}' "
        f"with models: {health.get('models', [])}"
    )


@app.on_event("shutdown")
async def shutdown_event():
    if milvus is not None:
        await milvus.aclose()


@app.exception_handler(DatabaseServiceError)
async def database_service_error_handler(request: Request, error: DatabaseServiceError):
    return Response(
        content=json.dumps({"detail": str(error)}),
        status_code=error.status_code,
        media_type="application/json",
    )

def verify_admin(credentials: HTTPBasicCredentials = Depends(security)):
    """Hàm xác thực admin qua Basic Auth"""
    correct_username = secrets.compare_digest(credentials.username, ADMIN_USERNAME)
    correct_password = secrets.compare_digest(credentials.password, ADMIN_PASSWORD)

    if not (correct_username and correct_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username

async def get_keys_by_pattern(pattern):
    keys = []
    cursor = 0
    while True:
        cursor, partial_keys = await redis_async_client.scan(cursor=cursor, match=pattern, count=100)
        keys.extend(partial_keys)
        if cursor == 0:
            break
    return keys


@app.get("/videos_hls/{video_name}/playlist.m3u8", tags=["HLS"])
async def get_hls_playlist(video_name: str):
    playlist_path = f"{hls_path}/{video_name}/playlist.m3u8"
    if not os.path.exists(playlist_path):
        raise HTTPException(status_code=404, detail="Playlist not found")
    # Media type cho M3U8 là application/vnd.apple.mpegurl
    return FileResponse(playlist_path, media_type="application/vnd.apple.mpegurl")

@app.get("/videos_hls/{video_name}/{segment_filename:path}", tags=["HLS"])
async def get_hls_segment(video_name: str, segment_filename: str):
    segment_path = os.path.join(hls_path, video_name, segment_filename)

    if not os.path.exists(segment_path) or not segment_path.startswith(os.path.realpath(hls_path)):
        raise HTTPException(status_code=404, detail="Segment not found")

    media_type = "application/octet-stream" # Giá trị mặc định
    if segment_filename.endswith('.ts'):
        media_type = "video/mp2t"
    elif segment_filename.endswith('.m4s') or segment_filename.endswith('.mp4'):
        media_type = "video/mp4"

    return FileResponse(segment_path, media_type=media_type)

@app.post("/api/admin/clear-cache")
async def clear_redis_cache(
    cache_type: str = "all",  # Options: "all", "temporal", "search", "rate_limit"
    admin: str = Depends(verify_admin)
):
    """
    Xóa cache trong Redis.

    - cache_type="all": Xóa tất cả cache
    - cache_type="temporal": Chỉ xóa temporal chains
    - cache_type="search": Chỉ xóa cache tìm kiếm
    - cache_type="rate_limit": Chỉ xóa rate limiting counters
    """
    try:
        if cache_type == "all":
            await redis_async_client.flushall()
            return {"success": True, "message": "All Redis cache cleared", "count": "all"}

        deleted_count = 0

        if cache_type == "temporal" or cache_type == "all":
            pattern = "temporal_chain:*"
            keys = await get_keys_by_pattern(pattern)
            if keys:
                deleted_count += await redis_async_client.delete(*keys)

        if cache_type == "search" or cache_type == "all":
            pattern = "search_text:*"
            keys = await redis_async_client.keys(pattern)
            if keys:
                deleted_count += await redis_async_client.delete(*keys)

            for func_name in ["get_video_info", "search_image"]:
                pattern = f"{func_name}:*"
                keys = await redis_async_client.keys(pattern)
                if keys:
                    deleted_count += await redis_async_client.delete(*keys)

        if cache_type == "rate_limit" or cache_type == "all":
            pattern = "rate_limit:*"
            keys = await redis_async_client.keys(pattern)
            if keys:
                deleted_count += await redis_async_client.delete(*keys)

        return {
            "success": True,
            "message": f"Cleared {cache_type} cache from Redis",
            "deleted_count": deleted_count
        }

    except Exception as e:

        traceback.print_exc()
        return {
            "success": False,
            "error": str(e)
        }

# Thêm một endpoint không cần xác thực để kiểm tra trạng thái Redis
@app.get("/api/admin/redis-stats")
async def redis_stats():
    """Lấy thống kê về dữ liệu trong Redis."""
    try:
        info = await redis_async_client.info()

        temporal_keys = len(await redis_async_client.keys("temporal_chain:*"))
        search_cache_keys = len(await redis_async_client.keys("search_text:*")) + len(await redis_async_client.keys("get_video_info:*"))
        rate_limit_keys = len(await redis_async_client.keys("rate_limit:*"))

        total_keys = int(info.get("db0", {}).get("keys", 0))

        # Sử dụng bộ nhớ
        used_memory = info.get("used_memory_human", "unknown")
        used_memory_peak = info.get("used_memory_peak_human", "unknown")

        return {
            "success": True,
            "total_keys": total_keys,
            "temporal_chains": temporal_keys,
            "search_cache": search_cache_keys,
            "rate_limit": rate_limit_keys,
            "other_keys": total_keys - temporal_keys - search_cache_keys - rate_limit_keys,
            "memory_usage": used_memory,
            "peak_memory_usage": used_memory_peak,
            "uptime_days": round(int(info.get("uptime_in_seconds", 0)) / 86400, 1)
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

# usage
# clear all cache: curl -X POST -u "admin:hlgay" http://192.168.20.152:8080/api/admin/clear-cache?cache_type=all
# clear temporal chains: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=temporal
# clear search cache: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=search
# clear rate limit counters: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=rate_limit
# get redis stats: curl http://192.168.20.156:8080/api/admin/redis-stats


def cache_result(permanent=True, expire_time=300):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            cache_key = f"{func.__name__}:{hashlib.md5(str(args).encode() + str(kwargs).encode()).hexdigest()}"

            # NON-BLOCKING: await the async call
            cached_result = await redis_async_client.get(cache_key)
            if cached_result:
                # No need to decode here if you set decode_responses=True
                return json.loads(cached_result)

            result = await func(*args, **kwargs)

            # NON-BLOCKING: await the async call
            if permanent:
                await redis_async_client.set(cache_key, json.dumps(result, default=str))
            else:
                await redis_async_client.setex(cache_key, expire_time, json.dumps(result, default=str))

            return result
        return wrapper
    return decorator

WEBSOCKET_CHANNEL = "submit_queue_channel"  # Tên kênh chung


class ConnectionManager:
    """Quản lý các kết nối WebSocket và đồng bộ qua Redis Pub/Sub."""
    def __init__(self):
        self.active_connections: Dict[str, set[WebSocket]] = {}
        self.connection_users: Dict[WebSocket, str] = {}
        self.connection_queues: Dict[WebSocket, asyncio.PriorityQueue] = {}
        self.writer_tasks: Dict[WebSocket, asyncio.Task] = {}
        self.message_sequence = 0
        self.redis_pubsub_client = None
        self.listener_task = None

    async def connect(self, websocket: WebSocket, username: str):
        """Chấp nhận kết nối mới và khởi tạo listener nếu cần."""
        await websocket.accept()
        self.active_connections.setdefault(username, set()).add(websocket)
        self.connection_users[websocket] = username
        self.connection_queues[websocket] = asyncio.PriorityQueue(maxsize=64)
        self.writer_tasks[websocket] = asyncio.create_task(self._connection_writer(websocket))

        # Chỉ khởi tạo một lần cho mỗi worker
        if self.redis_pubsub_client is None:
            self.redis_pubsub_client = await aioredis.from_url(REDIS_URL, decode_responses=True)
            self.listener_task = asyncio.create_task(self._pubsub_listener())

    async def _connection_writer(self, websocket: WebSocket):
        queue = self.connection_queues[websocket]
        try:
            while True:
                _, _, message = await queue.get()
                await asyncio.wait_for(websocket.send_text(message), timeout=2)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(f"Could not send WebSocket message: {error}")
        finally:
            self._remove_connection(websocket)

    def _remove_connection(self, websocket: WebSocket):
        username = self.connection_users.pop(websocket, None)
        if username is not None:
            user_connections = self.active_connections.get(username)
            if user_connections:
                user_connections.discard(websocket)
                if not user_connections:
                    self.active_connections.pop(username, None)

        self.connection_queues.pop(websocket, None)
        writer_task = self.writer_tasks.pop(websocket, None)
        if writer_task and writer_task is not asyncio.current_task():
            writer_task.cancel()

    def disconnect(self, username: str, websocket: Optional[WebSocket] = None):
        """Ngắt đúng connection, không làm ảnh hưởng reconnect mới của user."""
        connections = list(self.active_connections.get(username, set()))
        if websocket is not None:
            connections = [connection for connection in connections if connection is websocket]
        for connection in connections:
            self._remove_connection(connection)

    def enqueue(self, websocket: WebSocket, message: str, priority: int = 1) -> bool:
        queue = self.connection_queues.get(websocket)
        if queue is None:
            return False
        try:
            self.message_sequence += 1
            queue.put_nowait((priority, self.message_sequence, message))
            return True
        except asyncio.QueueFull:
            print("[WS] Closing slow client with a full outbound queue")
            self._remove_connection(websocket)
            asyncio.create_task(websocket.close(code=1013, reason="Outbound queue full"))
            return False

    async def _pubsub_listener(self):
        """Lắng nghe kênh Redis một cách kiên cường và tự động kết nối lại."""
        while True: # Vòng lặp chính để đảm bảo listener chạy mãi mãi
            try:
                # Kết nối lại nếu cần
                if self.redis_pubsub_client is None:
                    self.redis_pubsub_client = await aioredis.from_url(REDIS_URL, decode_responses=True)

                async with self.redis_pubsub_client.pubsub() as pubsub:
                    await pubsub.subscribe(WEBSOCKET_CHANNEL)
                    print(f"Worker (PID: {os.getpid()}) subscribed to '{WEBSOCKET_CHANNEL}'")

                    # Vòng lặp lắng nghe tin nhắn
                    while True:
                        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=None)
                        if message and message["type"] == "message":
                            living_connections = list(self.connection_queues)
                            for connection in living_connections:
                                self.enqueue(connection, message["data"])

            except (aioredis.exceptions.ConnectionError, asyncio.TimeoutError) as e:
                # Nếu mất kết nối với Redis, in lỗi và thử kết nối lại sau 1 khoảng thời gian
                print(f"Redis Pub/Sub connection error: {e}. Reconnecting in 5 seconds...")
                self.redis_pubsub_client = None
                await asyncio.sleep(5)
            except Exception as e:
                # Bắt các lỗi không lường trước khác, chờ và thử lại
                print(f"An unexpected error occurred in pubsub listener: {e}. Restarting in 5 seconds...")

                traceback.print_exc()
                self.redis_pubsub_client = None # Reset để kết nối lại
                await asyncio.sleep(5)

    async def publish_update(self, message: str):
        """Đăng (publish) một tin nhắn cập nhật lên kênh Redis."""
        await redis_async_client.publish(WEBSOCKET_CHANNEL, message)

# Khởi tạo manager
manager = ConnectionManager()

# Khóa các key trong Redis
QUEUE_SORTED_SET_KEY = "submit_queue:order"  # Sorted Set để lưu thứ tự (score, frameIdentifier)
QUEUE_DATA_HASH_KEY = "submit_queue:data"    # Hash để lưu dữ liệu chi tiết (frameIdentifier, jsonData)
QUEUE_USERS_KEY = "submit_queue:users"
TRAKE_QUEUE_STATE_KEY = "trake_queue:state"
TRAKE_QUEUE_VIDEO_KEY = "trake_queue:video"
TRAKE_SLOT_REVISION_KEY = "trake_queue:revisions"
TRAKE_REQUEST_PREFIX = "trake_queue:request:"
TRAKE_THUMBNAIL_DIR = PROJECT_DIR / "trake_thumbnails"
TRAKE_THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)

def get_color_for_user(username: str) -> str:
    """Tạo một màu sắc cố định dựa trên tên người dùng."""
    # Dùng hash để đảm bảo tên giống nhau luôn ra màu giống nhau
    hash_object = hashlib.sha256(username.encode())
    hex_dig = hash_object.hexdigest()
    # Lấy 6 ký tự đầu để tạo màu, đảm bảo độ sáng để dễ nhìn
    r = int(hex_dig[0:2], 16) % 128 + 128  # Sáng hơn
    g = int(hex_dig[2:4], 16) % 128 + 128
    b = int(hex_dig[4:6], 16) % 128 + 128
    return f"rgb({r},{g},{b})"




# Models
class TemporalStartRequest(BaseModel):
    query: str
    top_k: int = 650
    model_name: Optional[str] = None
    use_tag: Optional[bool] = False    # <<< THÊM VÀO
    top_k_tags: Optional[int] = 5
    tags_filter: Optional[List[str]] = None
    ocr: str = None
    asr: str = None
    ocr_mode: Optional[str] = "cascading"
    user_id: Optional[str] = None    # <<< THÊM VÀO
    query_id: Optional[str] = None
    use_event_filter: Optional[bool] = False
    ocr_fuzzy: Optional[bool] = False
    asr_fuzzy: Optional[bool] = False
    asr_mode: Optional[str] = "keyword"
    asr_top_k: Optional[int] = None
    cluster_mode_enabled: bool = True

class TemporalContinueRequest(BaseModel):
    query: str
    chain_id: str
    top_k: int = 500
    use_tag: Optional[bool] = False    # <<< THÊM VÀO
    top_k_tags: Optional[int] = 5
    tags_filter: Optional[List[str]] = None
    ocr: str = None
    asr: str = None
    ocr_mode: Optional[str] = "cascading"
    query_id: Optional[str] = None
    user_id: Optional[str] = None
    use_event_filter: Optional[bool] = False
    ocr_fuzzy: Optional[bool] = False
    asr_fuzzy: Optional[bool] = False
    asr_mode: Optional[str] = "keyword"
    asr_top_k: Optional[int] = None
    cluster_mode_enabled: bool = True

class TextToImageRequest(BaseModel):
    query: str
    top_k: int = 650
    model_name: Optional[str] = None
    use_tag: Optional[bool] = False
    top_k_tags: Optional[int] = 5
    tags_filter: Optional[List[str]] = None
    ocr: str = None
    asr: str = None
    ocr_mode: Optional[str] = "cascading"
    asr_mode: Optional[str] = "keyword"
    asr_top_k: Optional[int] = None
    use_event_filter: Optional[bool] = False
    cluster_mode_enabled: bool = True

class TextToTextRequest(BaseModel):
    query: str
    top_k: int = 650
    model_name: Optional[str] = None
    use_tag: Optional[bool] = False
    top_k_tags: Optional[int] = 5
    tags_filter: Optional[List[str]] = None
    ocr: str = None
    asr: str = None
    ocr_mode: Optional[str] = "cascading"
    asr_mode: Optional[str] = "keyword"
    asr_top_k: Optional[int] = None
    use_event_filter: Optional[bool] = False
    cluster_mode_enabled: bool = True


class ClusterFrameRequest(BaseModel):
    frame_specify: str


class ClusterMutationRequest(BaseModel):
    cluster_id: str


def log_search_debug(endpoint: str, **kwargs):
    print(f"\n[SEARCH DEBUG] endpoint={endpoint}")
    for key, value in kwargs.items():
        print(f"  {key}: {value}")

class FormSubmitRequest(BaseModel):
    video_name: str
    frame_indices: List[int]
    answer: Optional[str] = None
    filename: str
    conflict_action: Literal["error", "overwrite", "append"] = "error"


class FormSubmitFileUpdateRequest(BaseModel):
    content: str
    revision: str

@app.get("/api/debug/redis-test")
async def test_redis_connection():
    try:
        test_key = "test_connection"
        test_value = "working"
        await redis_async_client.setex(test_key, 60, test_value)
        retrieved = await redis_async_client.get(test_key)

        return {
            "status": "success",
            "message": "Redis connection is working",
            "test_value": retrieved
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Redis connection failed: {str(e)}"
        }

@app.get("/api/models")
async def get_available_models():
    """
    Trả về danh sách các model có sẵn để tìm kiếm.
    """
    models = await milvus.get_model_names()
    return {"models": models}


@app.post("/api/clusters/resolve-frame")
async def resolve_cluster_frame(req: ClusterFrameRequest):
    cluster = cluster_catalog.resolve_frame(req.frame_specify)
    if cluster is None:
        return {"found": False}

    deleted_cluster_ids = set(cluster_deletion_store.list_ids())
    return {"found": True, "already_deleted": cluster["cluster_id"] in deleted_cluster_ids, **cluster}


@app.post("/api/clusters/delete")
async def delete_cluster(req: ClusterMutationRequest):
    cluster = cluster_catalog.get_cluster(req.cluster_id)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    added, deleted_cluster_ids = cluster_deletion_store.add(cluster["cluster_id"])
    return {
        "success": True,
        "added": added,
        "cluster": {
            "cluster_id": cluster["cluster_id"],
            "count": cluster["count"],
            "representative": cluster["representative"],
        },
        "deleted_cluster_ids": deleted_cluster_ids,
    }


@app.get("/api/clusters/deleted")
async def get_deleted_clusters():
    deleted_cluster_ids = cluster_deletion_store.list_ids()
    return {
        "clusters": cluster_catalog.deleted_summaries(deleted_cluster_ids),
        "deleted_cluster_ids": deleted_cluster_ids,
    }


@app.get("/api/clusters/{cluster_id}")
async def get_deleted_cluster_detail(cluster_id: str):
    if cluster_id not in set(cluster_deletion_store.list_ids()):
        raise HTTPException(status_code=404, detail="Cluster is not deleted")

    cluster = cluster_catalog.get_cluster(cluster_id)
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return cluster


@app.post("/api/clusters/undo")
async def undo_cluster_deletion(req: ClusterMutationRequest):
    cluster_id = str(req.cluster_id)
    removed, deleted_cluster_ids = cluster_deletion_store.remove(cluster_id)
    return {
        "success": True,
        "removed": removed,
        "deleted_cluster_ids": deleted_cluster_ids,
    }

@app.get("/api/debug/temporal-chain/{chain_id}")
async def debug_temporal_chain(chain_id: str):
    try:
        chain_key = f"temporal_chain:{chain_id}"
        chain_data_str = await redis_async_client.get(chain_key)

        if not chain_data_str:
            return {
                "exists": False,
                "message": "Chain not found in Redis"
            }

        try:
            chain_data = json.loads(chain_data_str)
            state_keys = list(chain_data.get("state", {}).keys())

            return {
                "exists": True,
                "last_update": chain_data.get("last_update"),
                "state_keys": state_keys,
                "data_size_bytes": len(chain_data_str)
            }
        except Exception as parse_err:
            return {
                "exists": True,
                "parse_error": str(parse_err),
                "raw_data_sample": chain_data_str[:100]
            }
    except Exception as e:
        return {
            "error": str(e)
        }

# API Routes
@app.get("/frames/{video_name}/{frame_name}")
async def get_frame(video_name: str, frame_name: str):
    frame_path = f"{keysframe_path_root}/{video_name}/{frame_name}"

    if not os.path.exists(frame_path):
        raise HTTPException(status_code=404, detail="Frame not found")

    return FileResponse(
        frame_path,
        media_type="image/webp",
        headers={
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=43200",
            "ETag": f"\"{os.path.getmtime(frame_path)}\"",  # Thêm ETag
        }
    )

@app.get("/videos/{video_name}")
async def get_video(video_name: str):
    video_path = f"{video_path_root}/{video_name}"

    # Kiểm tra file tồn tại
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Video not found")

    # Trả về FileResponse với headers phù hợp
    return FileResponse(
        video_path,
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        }
    )

@app.get("/api/debug/check-video/{video_name}")
def check_video(video_name: str):
    import os
    video_path = f"{video_path_root}/{video_name}.mp4"
    exists = os.path.exists(video_path)

    if exists:
        file_size = os.path.getsize(video_path)
        return {
            "exists": True,
            "path": video_path,
            "size_mb": round(file_size / (1024*1024), 2),
            "readable": os.access(video_path, os.R_OK)
        }
    else:
        # List các file có trong thư mục để debug
        video_dir = video_path_root
        files = os.listdir(video_dir) if os.path.exists(video_dir) else []
        return {
            "exists": False,
            "path": video_path,
            "available_files": files[:10]  # Show first 10 files
        }

@app.post("/api/search/text-to-image")
async def search_text_to_image(req: TextToImageRequest):
    cluster_filter = get_search_cluster_filter(req.cluster_mode_enabled)
    log_search_debug(
        "text-to-image",
        query=req.query,
        mode="text",
        search_in="image",
        top_k=min(req.top_k, 1000),
        requested_top_k=req.top_k,
        model_name=req.model_name,
        use_tag=req.use_tag,
        top_k_tags=req.top_k_tags,
        tags_filter=req.tags_filter,
        ocr=req.ocr,
        asr=req.asr,
        use_event_filter=req.use_event_filter,
        cluster_filter_count=len(cluster_filter),
        cluster_mode_enabled=req.cluster_mode_enabled,
    )
    results = await milvus.search(
        query=req.query,
        mode="text",
        search_in="image",
        top_k=min(req.top_k, 1000),
        start_temporal_chain=False,
        model_name=req.model_name,
        use_tag=req.use_tag,
        top_k_tags=req.top_k_tags,
        tags_filter=req.tags_filter,
        ocr=req.ocr,
        ocr_mode=getattr(req, "ocr_mode", "cascading"),
        asr=req.asr,
        asr_mode=getattr(req, "asr_mode", "keyword"),
        asr_top_k=getattr(req, "asr_top_k", None),
        use_event_filter=req.use_event_filter,
        user_filter=cluster_filter,
        cluster_mode_enabled=req.cluster_mode_enabled,
    )
    return process_milvus_results_for_frontend(results)

@app.post("/api/search/text-to-text")
async def search_text_to_text(req: TextToTextRequest):
    cluster_filter = get_search_cluster_filter(req.cluster_mode_enabled)
    log_search_debug(
        "text-to-text",
        query=req.query,
        mode="text",
        search_in="text",
        top_k=min(req.top_k, 1000),
        requested_top_k=req.top_k,
        model_name=req.model_name,
        use_tag=req.use_tag,
        top_k_tags=req.top_k_tags,
        tags_filter=req.tags_filter,
        ocr=req.ocr,
        asr=req.asr,
        use_event_filter=req.use_event_filter,
        cluster_filter_count=len(cluster_filter),
        cluster_mode_enabled=req.cluster_mode_enabled,
    )
    results = await milvus.search(
        query=req.query,
        mode="text",
        search_in="text",
        top_k=min(req.top_k, 1000),
        start_temporal_chain=False,
        model_name=req.model_name,
        use_tag=req.use_tag,
        top_k_tags=req.top_k_tags,
        tags_filter=req.tags_filter,
        ocr=req.ocr,
        ocr_mode=getattr(req, "ocr_mode", "cascading"),
        asr=req.asr,
        asr_mode=getattr(req, "asr_mode", "keyword"),
        asr_top_k=getattr(req, "asr_top_k", None),
        use_event_filter=req.use_event_filter,
        user_filter=cluster_filter,
        cluster_mode_enabled=req.cluster_mode_enabled,
    )
    return process_milvus_results_for_frontend(results)

@app.post("/api/search/image")
async def search_image(
    file: UploadFile = File(..., description="File ảnh để tìm kiếm"),
    top_k: int = Form(600, description="Số lượng kết quả trả về"),
    model_name = "google/siglip2-large-patch16-512",  # Mặc định model
    use_tag: bool = Form(False, description="Enable tag filtering"),
    top_k_tags: int = Form(5, description="Top K tags to use"),
    use_event_filter: bool = Form(False, description="Enable event filtering"),
    cluster_mode_enabled: bool = Form(True, description="Apply global cluster exclusions")
):
    """
    Nhận một file ảnh, truyền nó vào Milvus để tìm kiếm các ảnh tương tự
    và trả về danh sách kết quả.
    """
    # Đọc nội dung của file ảnh dưới dạng bytes
    image_bytes = await file.read()

    cluster_filter = get_search_cluster_filter(cluster_mode_enabled)
    log_search_debug(
        "image-to-image",
        query=f"uploaded_file:{file.filename}",
        mode="image",
        search_in="image",
        top_k=min(top_k, 1000),
        requested_top_k=top_k,
        model_name="google/siglip2-large-patch16-512",
        use_tag=use_tag,
        top_k_tags=top_k_tags,
        use_event_filter=use_event_filter,
        cluster_filter_count=len(cluster_filter),
        uploaded_bytes=len(image_bytes),
        cluster_mode_enabled=cluster_mode_enabled,
    )

    # Gọi hàm search của Milvus với mode="image"
    results = await milvus.search(
        query=image_bytes,
        mode="image",
        search_in="image",
        top_k=min(top_k, 1000),  # Giới hạn top_k
        model_name="google/siglip2-large-patch16-512",
        use_tag=use_tag,            # <<< TRUYỀN THAM SỐ
        top_k_tags=top_k_tags,
        use_event_filter=use_event_filter,
        user_filter=cluster_filter,
        cluster_mode_enabled=cluster_mode_enabled,
    )

    return process_milvus_results_for_frontend(results)


@app.post("/api/session/cleanup")
async def cleanup_session(user_id: str = Form(...)):
    """
    Endpoint to clear a user's temporal chain state.
    Designed to be called with navigator.sendBeacon().
    """
    try:
        if user_id:
            print(f"Cleaning up temporal session for user: {user_id}")
            await milvus.clear_temporal_chain(user_id=user_id)
        return {"success": True, "message": f"Session for {user_id} cleared."}
    except Exception as e:
        # Even if it fails, return success to not block the browser unloading.
        print(f"ERROR during session cleanup for {user_id}: {e}")
        return {"success": False, "error": str(e)}

@app.post("/api/search/temporal/start_with_image")
async def temporal_search_start_with_image(
    file: UploadFile = File(..., description="File ảnh để bắt đầu chuỗi tìm kiếm"),
    top_k: int = Form(600, description="Số lượng kết quả trả về"),
    model_name: Optional[str] = Form(None, description="Tên model để sử dụng"),
    user_id: str = Form(..., description="User ID for the session"),   # <<< THÊM VÀO
    query_id: str = Form(..., description="Query ID for this action"),
    use_event_filter: bool = Form(False, description="Enable event filtering"),
    cluster_mode_enabled: bool = Form(True, description="Apply global cluster exclusions")
):
    """
    Bắt đầu một chuỗi tìm kiếm temporal mới bằng một hình ảnh.
    Trả về kết quả tìm kiếm ban đầu và một chain_id mới.
    """
    try:
        # 1. Tạo một chain_id mới và duy nhất
        chain_id = str(uuid.uuid4())

        # 2. Đọc nội dung ảnh
        image_bytes = await file.read()

        cluster_filter = get_search_cluster_filter(cluster_mode_enabled)
        log_search_debug(
            "temporal-start-with-image",
            query=f"uploaded_file:{file.filename}",
            mode="image",
            search_in="image",
            top_k=min(top_k, 1000),
            requested_top_k=top_k,
            model_name=model_name,
            user_id=user_id,
            query_id=query_id,
            chain_id=chain_id,
            use_event_filter=use_event_filter,
            cluster_filter_count=len(cluster_filter),
            uploaded_bytes=len(image_bytes),
            cluster_mode_enabled=cluster_mode_enabled,
        )

        initial_results = await milvus.search(
            query=image_bytes,
            mode="image",
            search_in="image",
            start_temporal_chain=True,
            top_k=min(top_k, 1000),
            model_name=model_name,
            user_id=user_id,      # <<< THÊM VÀO
            query_id=query_id,
            use_event_filter=use_event_filter,
            user_filter=cluster_filter,
            cluster_mode_enabled=cluster_mode_enabled,
        )

        return {
            "chain_id": chain_id,
            "initial_results": process_milvus_results_for_frontend(initial_results)
        }

    except DatabaseServiceError:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/asr_transcript", tags=["Transcripts & Text"])
async def fetch_asr_transcript(
    frame_specify: Optional[str] = Query(None, description="Frame identifier e.g. L21_V001/0123.jpg"),
    video_name: Optional[str] = Query(None, description="Video name e.g. L21_V001"),
    timestamp: Optional[float] = Query(None, description="Timestamp in seconds e.g. 12.5"),
    frame_id: Optional[int] = Query(None, description="Frame ID integer e.g. 123"),
    video_id: Optional[str] = Query(None, description="Video ID (alias for video_name)"),
    time_stamp: Optional[float] = Query(None, description="Timestamp in seconds (alias for timestamp)"),
    model_name: Optional[str] = Query(None, description="Target Milvus model name"),
):
    """Fetches ASR transcript details for a frame or video timestamp."""
    target_vid = video_name or video_id
    target_ts = timestamp if timestamp is not None else time_stamp
    if not frame_specify and not (target_vid and (target_ts is not None or frame_id is not None)):
        raise HTTPException(
            status_code=400,
            detail="Must provide either 'frame_specify', ('video_name' and 'frame_id'), or ('video_name' and 'timestamp')",
        )
    try:
        result = await milvus.get_asr_transcript_for_frame(
            frame_specify=frame_specify,
            video_name=target_vid,
            timestamp=target_ts,
            frame_id=frame_id,
            model_name=model_name,
        )
        return result
    except DatabaseServiceError:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/transcripts/{video_name}", tags=["Transcripts & Text"])
async def fetch_video_transcript(video_name: str, request: Request, response: Response):
    """Return the complete timestamped ASR transcript for one video."""
    if transcript_store.error:
        raise HTTPException(status_code=503, detail="Transcript data is unavailable")

    transcript = transcript_store.get(video_name)
    if transcript is None:
        raise HTTPException(status_code=404, detail=f"Transcript for {video_name} not found")

    response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
    if transcript_store.etag:
        response.headers["ETag"] = transcript_store.etag
        if request.headers.get("if-none-match") == transcript_store.etag:
            response.status_code = 304
            return None
    return transcript


@app.get("/api/ocr_text", tags=["Transcripts & Text"])
async def fetch_ocr_text(
    frame_specify: Optional[str] = Query(None, description="Frame identifier e.g. L21_V001/0123.jpg"),
    video_name: Optional[str] = Query(None, description="Video name e.g. L21_V001"),
    timestamp: Optional[float] = Query(None, description="Timestamp in seconds e.g. 12.5"),
    frame_id: Optional[int] = Query(None, description="Frame ID integer e.g. 123"),
    video_id: Optional[str] = Query(None, description="Video ID (alias for video_name)"),
    time_stamp: Optional[float] = Query(None, description="Timestamp in seconds (alias for timestamp)"),
    model_name: Optional[str] = Query(None, description="Target Milvus model name"),
):
    """Fetches OCR text recognized on a specific frame."""
    target_vid = video_name or video_id
    target_ts = timestamp if timestamp is not None else time_stamp
    if not frame_specify and not (target_vid and (target_ts is not None or frame_id is not None)):
        raise HTTPException(
            status_code=400,
            detail="Must provide either 'frame_specify', ('video_name' and 'frame_id'), or ('video_name' and 'timestamp')",
        )
    try:
        result = await milvus.get_ocr_text_for_frame(
            frame_specify=frame_specify,
            video_name=target_vid,
            timestamp=target_ts,
            frame_id=frame_id,
            model_name=model_name,
        )
        return result
    except DatabaseServiceError:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/frame_text", tags=["Transcripts & Text"])
async def fetch_frame_text(
    frame_specify: Optional[str] = Query(None, description="Frame identifier e.g. L21_V001/0123.jpg"),
    video_name: Optional[str] = Query(None, description="Video name e.g. L21_V001"),
    timestamp: Optional[float] = Query(None, description="Timestamp in seconds e.g. 12.5"),
    frame_id: Optional[int] = Query(None, description="Frame ID integer e.g. 123"),
    video_id: Optional[str] = Query(None, description="Video ID (alias for video_name)"),
    time_stamp: Optional[float] = Query(None, description="Timestamp in seconds (alias for timestamp)"),
    model_name: Optional[str] = Query(None, description="Target Milvus model name"),
):
    """Fetches both ASR transcript and OCR text for a specific frame."""
    target_vid = video_name or video_id
    target_ts = timestamp if timestamp is not None else time_stamp
    if not frame_specify and not (target_vid and (target_ts is not None or frame_id is not None)):
        raise HTTPException(
            status_code=400,
            detail="Must provide either 'frame_specify', ('video_name' and 'frame_id'), or ('video_name' and 'timestamp')",
        )
    try:
        asr_data, ocr_data = await asyncio.gather(
            milvus.get_asr_transcript_for_frame(
                frame_specify=frame_specify,
                video_name=target_vid,
                timestamp=target_ts,
                frame_id=frame_id,
                model_name=model_name,
            ),
            milvus.get_ocr_text_for_frame(
                frame_specify=frame_specify,
                video_name=target_vid,
                timestamp=target_ts,
                frame_id=frame_id,
                model_name=model_name,
            ),
        )
        return {
            "frame_id": frame_id or asr_data.get("frame_id") or ocr_data.get("frame_id"),
            "frame_specify": frame_specify or ocr_data.get("frame_specify") or asr_data.get("frame_specify"),
            "video_name": target_vid or asr_data.get("video_name"),
            "timestamp": target_ts if target_ts is not None else asr_data.get("timestamp"),
            "asr": asr_data,
            "ocr": ocr_data,
        }
    except DatabaseServiceError:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/metadata/{video_id}")
async def get_frame_metadata(video_id: str):
    """
    Phục vụ file metadata.json cho một video cụ thể.
    """
    # Đường dẫn đến file metadata.json trên server
    metadata_path = f"{keysframe_path_root}/{video_id}/metadata.json"

    # Kiểm tra xem file có tồn tại không
    if not os.path.exists(metadata_path):
        raise HTTPException(
            status_code=404,
            detail=f"Metadata file not found for video {video_id}"
        )

    # Trả về file dưới dạng JSON
    return FileResponse(
        metadata_path,
        media_type="application/json",
        # headers={
        #     # Bạn có thể cache file này để tăng tốc độ
        #     "Cache-Control": "public, max-age=3600",
        # }
    )

@app.get("/api/video_info/{video_id}")
@cache_result(expire_time=3600)  # Cache 1 giờ
async def get_video_info(video_id: str):
    """
    API này sẽ đếm và liệt kê tất cả các file ảnh trong một thư mục video.
    """
    # THAY ĐỔI: Đường dẫn mới
    video_path_image = f"{keysframe_path_root}/{video_id}"

    if not os.path.isdir(video_path_image):
        raise HTTPException(status_code=404, detail="Video folder not found")

    try:
        # Lấy tất cả file .webp trong thư mục
        all_files = [f for f in os.listdir(video_path_image) if f.lower().endswith('.webp')]

        # Sắp xếp theo thứ tự frame
        all_files.sort(key=lambda name: int(name.split('_')[1].split('.')[0]))

        return {
            "total_frames": len(all_files),
            "frame_filenames": all_files,
            "folder_url_path": f"/frames/{video_id}"  # Đường dẫn URL mới
        }
    except Exception as e:
        print(f"Error processing directory {video_id}: {e}")
        raise HTTPException(status_code=500, detail="Error on server")

@lru_cache(maxsize=128)
def _load_and_sort_metadata(video_id: str):
    """Hàm helper để đọc, chuyển đổi và sắp xếp metadata cho một video."""
    metadata_path = f"{keysframe_path_root}/{video_id}/metadata.json"
    if not os.path.exists(metadata_path):
        return None

    with open(metadata_path, 'r') as f:
        metadata_file_content = json.load(f)

    # Metadata có thể nằm trong một key trùng tên với video_id
    video_metadata = metadata_file_content.get(video_id, metadata_file_content)

    # Chuyển đổi từ dict của dicts sang list của dicts và thêm 'filename'
    frames_list = []
    for frame_key, frame_data in video_metadata.items():
        # Đảm bảo frame_data là một dict và có 'id'
        if isinstance(frame_data, dict) and 'id' in frame_data:
            frame_data['filename'] = f"{frame_key}.webp"
            frame_data['frame_id_ori'] = frame_data['id']
            frames_list.append(frame_data)

    # Sắp xếp danh sách dựa trên frame ID gốc
    frames_list.sort(key=lambda x: x['frame_id_ori'])
    return frames_list

def _metadata_timestamp_to_seconds(value):
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if not isinstance(value, str):
        return 0.0

    parts = value.strip().split(':')
    try:
        if len(parts) == 3:
            return max(0.0, int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2]))
        if len(parts) == 2:
            return max(0.0, int(parts[0]) * 60 + float(parts[1]))
        return max(0.0, float(parts[0]))
    except (TypeError, ValueError):
        return 0.0

@lru_cache(maxsize=128)
def _load_keyframe_index(video_id: str):
    sorted_frames = _load_and_sort_metadata(video_id)
    if sorted_frames is None:
        return None

    compact_frames = []
    fps = None
    for frame in sorted_frames:
        timestamp = _metadata_timestamp_to_seconds(frame.get('time-stamp', frame.get('timestamp', 0)))
        frame_fps = frame.get('fps')
        if fps is None and isinstance(frame_fps, (int, float)) and frame_fps > 0:
            fps = float(frame_fps)
        compact_frames.append({
            'frame_id_ori': frame['frame_id_ori'],
            'timestamp': timestamp,
            'filename': frame['filename'],
        })

    compact_frames.sort(key=lambda frame: (frame['timestamp'], frame['frame_id_ori']))
    return {
        'fps': fps,
        'frames': compact_frames,
        'timestamps': [frame['timestamp'] for frame in compact_frames],
        'frame_indices': {frame['frame_id_ori']: index for index, frame in enumerate(compact_frames)},
    }

@app.get("/api/keyframes/neighbors/{video_id}/{frame_id_ori}")
async def get_neighboring_keyframes(
    video_id: str,
    frame_id_ori: int,
    look_behind: int = 50, # Mặc định cho openImageModal
    look_ahead: int = 50   # Mặc định cho openImageModal
):
    """
    Lấy các keyframe lân cận của một frame cụ thể với phạm vi tùy chỉnh.
    """
    sorted_frames = _load_and_sort_metadata(video_id)
    if sorted_frames is None:
        raise HTTPException(status_code=404, detail=f"Metadata for video {video_id} not found.")

    try:
        target_index = next(i for i, frame in enumerate(sorted_frames) if frame['frame_id_ori'] == frame_id_ori)
    except StopIteration:
        raise HTTPException(status_code=404, detail=f"Frame ID {frame_id_ori} not found in video {video_id}.")

    # >>> LOGIC MỚI: Tính toán khoảng dựa trên look_behind và look_ahead <<<
    start_index = max(0, target_index - look_behind)
    end_index = min(len(sorted_frames), target_index + look_ahead + 1)

    neighboring_frames = sorted_frames[start_index:end_index]

    # Chuẩn hóa tên thuộc tính trước khi trả về
    normalized_frames = []
    for frame in neighboring_frames:
        new_frame = frame.copy()
        if 'time-stamp' in new_frame:
            new_frame['timestamp'] = new_frame.pop('time-stamp')
        normalized_frames.append(new_frame)

    return normalized_frames

@app.get("/api/keyframes/window/{video_id}")
async def get_keyframe_window(
    video_id: str,
    response: Response,
    timestamp: float = Query(0.0, ge=0.0),
    frame_id_ori: Optional[int] = Query(None, ge=0),
    before: int = Query(25, ge=0, le=100),
    after: int = Query(25, ge=0, le=100),
):
    """Return a compact keyframe window anchored by timestamp or exact frame ID."""
    keyframe_index = _load_keyframe_index(video_id)
    if keyframe_index is None:
        raise HTTPException(status_code=404, detail=f"Metadata for video {video_id} not found.")

    frames = keyframe_index['frames']
    if not frames:
        return {
            'video_name': video_id,
            'fps': keyframe_index['fps'],
            'center_index': -1,
            'window_start_index': 0,
            'window_end_index': 0,
            'total_frames': 0,
            'has_previous': False,
            'has_next': False,
            'frames': [],
        }

    if frame_id_ori is not None:
        center_index = keyframe_index['frame_indices'].get(frame_id_ori)
        if center_index is None:
            raise HTTPException(status_code=404, detail=f"Frame ID {frame_id_ori} not found in video {video_id}.")
    else:
        center_index = max(0, bisect_right(keyframe_index['timestamps'], timestamp) - 1)
    start_index = max(0, center_index - before)
    end_index = min(len(frames), center_index + after + 1)
    response.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=86400'
    return {
        'video_name': video_id,
        'fps': keyframe_index['fps'],
        'center_index': center_index,
        'window_start_index': start_index,
        'window_end_index': end_index,
        'total_frames': len(frames),
        'has_previous': start_index > 0,
        'has_next': end_index < len(frames),
        'frames': frames[start_index:end_index],
    }



@app.post("/api/search/temporal/start")
async def temporal_search_start(req: TemporalStartRequest):
    try:
        # 1. Sử dụng user_id từ request làm chain_id
        if not req.user_id: # <<< THÊM VÀO
            raise HTTPException(status_code=400, detail="user_id is required to start a temporal chain.") # <<< THÊM VÀO

        chain_id = req.user_id # <<< THAY ĐỔI

        cluster_filter = get_search_cluster_filter(req.cluster_mode_enabled)

        # lower_query = req.query.lower() if req.query else ""
        # lower_tag = [s.lower() for s in req.tags_filter] if req.tags_filter else None
        # lower_ocr = req.ocr.lower() if req.ocr else None
        log_search_debug(
            "temporal-start",
            query=req.query,
            mode="text",
            search_in="image",
            top_k=min(req.top_k, 1000),
            requested_top_k=req.top_k,
            model_name=req.model_name,
            user_id=req.user_id,
            query_id=req.query_id,
            chain_id=chain_id,
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            tags_filter=req.tags_filter,
            ocr=req.ocr,
            asr=req.asr,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            cluster_filter_count=len(cluster_filter),
            cluster_mode_enabled=req.cluster_mode_enabled,
        )
        # 2. Thực hiện tìm kiếm đầu tiên với user_id và query_id
        initial_results = await milvus.search(
            query=req.query,
            mode="text",
            search_in="image",
            start_temporal_chain=True,
            top_k=min(req.top_k, 1000),
            model_name=req.model_name,
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            tags_filter=req.tags_filter,
            ocr = req.ocr,
            ocr_mode = getattr(req, "ocr_mode", "cascading"),
            asr = req.asr,
            asr_mode = getattr(req, "asr_mode", "keyword"),
            asr_top_k = getattr(req, "asr_top_k", None),
            user_id=req.user_id,    # <<< THÊM VÀO
            query_id=req.query_id,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            user_filter=cluster_filter,
            cluster_mode_enabled=req.cluster_mode_enabled,
        )
        return {
            "chain_id": chain_id,
            "initial_results": process_milvus_results_for_frontend(initial_results)
        }

    except DatabaseServiceError:
        raise
    except Exception as e:
        print(f"ERROR in temporal_search_start: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/search/temporal/continue")
async def temporal_search_continue(req: TemporalContinueRequest):
    try:
        # 1. Kiểm tra xem chain_id có tồn tại trong Redis không

        cluster_filter = get_search_cluster_filter(req.cluster_mode_enabled)
        log_search_debug(
            "temporal-continue",
            query=req.query,
            mode="text",
            search_in="image",
            top_k=min(req.top_k, 1000),
            requested_top_k=req.top_k,
            chain_id=req.chain_id,
            user_id=req.user_id,
            query_id=req.query_id,
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            tags_filter=req.tags_filter,
            ocr=req.ocr,
            asr=req.asr,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            cluster_filter_count=len(cluster_filter),
            cluster_mode_enabled=req.cluster_mode_enabled,
        )

        # 4. Thực hiện temporal search sequence
        temporal_answer = await milvus.temporal_search_sequence(
            query=req.query,
            mode="text",
            top_k=min(req.top_k, 1000),
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            tags_filter=req.tags_filter,
            ocr = req.ocr,
            ocr_mode = getattr(req, "ocr_mode", "cascading"),
            asr = req.asr,
            asr_mode = getattr(req, "asr_mode", "keyword"),
            asr_top_k = getattr(req, "asr_top_k", None),
            user_id=req.chain_id,  # <<< THÊM VÀO (chain_id từ client chính là user_id)
            query_id=req.query_id,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            user_filter=cluster_filter,
            cluster_mode_enabled=req.cluster_mode_enabled,
        )

        reranked_list = temporal_answer.get("query_A_reranked", [])
        processed_reranked_list = process_milvus_results_for_frontend(reranked_list)

        # current_query_results = temporal_answer.get("current_query_results", [])
        # )

        return {
            "query_idx": temporal_answer.get("query_idx"),
            # "current_query_results": current_query_results,
            "query_A_reranked": processed_reranked_list
        }

    except DatabaseServiceError:
        raise
    except Exception as e:
        print(f"ERROR in temporal_search_continue: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search/temporal/continue_with_image")
async def temporal_search_continue_with_image(
    file: UploadFile = File(..., description="Image used as the next temporal query"),
    chain_id: str = Form(..., description="Active temporal chain ID"),
    query_id: str = Form(..., description="Query ID for this image step"),
    top_k: int = Form(500, description="Number of image candidates to retrieve"),
    model_name: Optional[str] = Form(None),
    use_event_filter: bool = Form(False),
    cluster_mode_enabled: bool = Form(True),
):
    """Append a selected frame as an image query to the active temporal chain."""
    try:
        image_bytes = await file.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="Image file is empty.")

        cluster_filter = get_search_cluster_filter(cluster_mode_enabled)
        log_search_debug(
            "temporal-continue-with-image",
            query=f"uploaded_file:{file.filename}",
            mode="image",
            search_in="image",
            top_k=min(top_k, 1000),
            requested_top_k=top_k,
            model_name=model_name,
            chain_id=chain_id,
            query_id=query_id,
            use_event_filter=use_event_filter,
            cluster_filter_count=len(cluster_filter),
            uploaded_bytes=len(image_bytes),
            cluster_mode_enabled=cluster_mode_enabled,
        )
        temporal_answer = await milvus.temporal_search_sequence_with_image(
            query=image_bytes,
            user_id=chain_id,
            query_id=query_id,
            top_k=min(top_k, 1000),
            model_name=model_name,
            use_event_filter=use_event_filter,
            user_filter=cluster_filter,
            cluster_mode_enabled=cluster_mode_enabled,
        )
        reranked_list = temporal_answer.get("query_A_reranked", [])
        return {
            "query_A_reranked": process_milvus_results_for_frontend(reranked_list),
        }
    except DatabaseServiceError:
        raise
    except HTTPException:
        raise
    except Exception as e:
        print(f"ERROR in temporal_search_continue_with_image: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def process_milvus_results_for_frontend(results: list) -> list:
    processed_list = []
    start = time.time()
    for res in results:
        metadata = res.get("metadata", {})
        frame_name = metadata.get("frame_name", "unknown_frame")
        try:
            video_name = metadata.get("video_name")
        except:
            raise HTTPException(
                status_code=500,
                detail="Metadata missing 'video_name' field"
            )

        # THAY ĐỔI: Đường dẫn mới cho frames
        full_frame_name = frame_name if frame_name.endswith('.webp') else f"{frame_name}.webp"
        #normal
        path = f"/frames/{video_name}/{full_frame_name}"  # Đường dẫn URL mới
        # Đường dẫn video giữ nguyên
        video_path = f"/videos/{video_name}.mp4"

        match = re.search(r'_(\d+)', frame_name)
        frame_id = int(match.group(1)) if match else 0
        temporal_chain_data = res.get("temporal_chain", {})
        frame_id_ori = metadata.get("frame_id", 0)  # Lấy frame_id từ metadata, mặc định là 0 nếu không có
        frame_identifier = f"{video_name}_{frame_id_ori}"
        fps_value = metadata.get("fps", 1)
        score = res.get("score", res.get("temporal_score", res.get("original_score", res.get("sim_score", 0))))
        processed_list.append({
            "frame_id_ori": frame_id_ori,  # Thêm frame_id_ori
            "path": path,  # Đường dẫn mới
            "videoName": video_name,
            "timestamp": metadata.get("timestamp", "00:00.000"),
            "score": score,
            "temporal_score": res.get("temporal_score"),
            "frameIdentifier": frame_identifier,
            "frame_specify": metadata.get("frame_specify", f"{video_name}/{frame_name}"),
            "cluster_id": res.get("cluster_id", ""),
            "has_temporal_chain": True if temporal_chain_data and len(temporal_chain_data) > 0 else False
        })
    end = time.time()
    print(f"Processed {len(results)} results in {end - start:.4f} seconds")
    print("Top 5 frontend search results:")
    for index, item in enumerate(processed_list[:5], start=1):
        print(
            f"  {index}. frameIdentifier={item.get('frameIdentifier')} "
            f"videoName={item.get('videoName')} "
            f"timestamp={item.get('timestamp')} "
            f"score={item.get('score')} "
            f"path={item.get('path')}"
        )
    return processed_list

@app.get("/api/temporal-chain/{user_id}/{frame_identifier}")
async def get_single_frame_temporal_chain(user_id: str, frame_identifier: str):
    # This logic is conceptual. You need to implement how to retrieve
    # the specific chain data from your MilvusManager/Redis state.
    try:
        chain_data = await milvus.get_temporal_chain_for_frame(user_id, frame_identifier)
        if not chain_data:
             raise HTTPException(status_code=404, detail="Temporal chain not found for this frame.")
        return chain_data
    except DatabaseServiceError:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def get_trake_queue_items() -> list[dict]:
    raw_frames = await redis_async_client.hgetall(TRAKE_QUEUE_STATE_KEY)
    frames = []
    for raw_event_number, raw_frame in raw_frames.items():
        try:
            frame = json.loads(raw_frame)
            frame["eventNumber"] = int(raw_event_number)
            frame.pop("status", None)
            frame.pop("thumbnailUrl", None)
            frames.append(frame)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return sorted(frames, key=lambda frame: frame["eventNumber"])


async def send_trake_message(websocket: WebSocket, action: str, payload):
    manager.enqueue(websocket, json.dumps({"action": action, "payload": payload}), priority=0)


def schedule_trake_broadcast(message: str):
    async def publish():
        for attempt, delay in enumerate((0, 0.5, 1.5), start=1):
            if delay:
                await asyncio.sleep(delay)
            try:
                await manager.publish_update(message)
                return
            except Exception as error:
                print(f"[TRAKE] Broadcast attempt {attempt} failed: {error}")

    asyncio.create_task(publish())


TRAKE_ASSIGN_SCRIPT = """
local cached = redis.call('GET', KEYS[4])
if cached then
    return {2, cached}
end
local locked_video = redis.call('GET', KEYS[3])
if locked_video and locked_video ~= ARGV[2] then
    return {0, locked_video}
end
local revision = redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
local frame = cjson.decode(ARGV[3])
frame.revision = revision
local encoded_frame = cjson.encode(frame)
redis.call('HSET', KEYS[1], ARGV[1], encoded_frame)
redis.call('SET', KEYS[3], ARGV[2])
redis.call('SETEX', KEYS[4], 86400, encoded_frame)
return {1, encoded_frame}
"""


async def assign_trake_slot(websocket: WebSocket, username: str, payload: dict):
    request_id = str(payload.get("requestId") or "")
    event_number = payload.get("eventNumber")
    video_name = str(payload.get("videoName") or "")
    frame_index = payload.get("frameIndex", payload.get("frame_id_ori"))
    try:
        event_number = int(event_number)
    except (TypeError, ValueError):
        event_number = 0
    if not request_id or event_number not in range(1, 6) or not video_name:
        await send_trake_message(websocket, "trake_conflict", {
            "requestId": request_id,
            "eventNumber": event_number,
            "reason": "invalid_payload"
        })
        return
    try:
        frame_index = int(frame_index)
    except (TypeError, ValueError):
        await send_trake_message(websocket, "trake_conflict", {
            "requestId": request_id,
            "eventNumber": event_number,
            "reason": "invalid_frame"
        })
        return

    try:
        fps = float(payload.get("fps"))
        if fps <= 0:
            raise ValueError
    except (TypeError, ValueError):
        await send_trake_message(websocket, "trake_conflict", {
            "requestId": request_id,
            "eventNumber": event_number,
            "reason": "invalid_fps"
        })
        return

    timestamp_ms = int(payload.get("timestampMs", round(frame_index / fps * 1000)))
    frame = {
        "requestId": request_id,
        "eventNumber": event_number,
        "videoName": video_name,
        "frameIndex": frame_index,
        "frame_id_ori": frame_index,
        "timestampMs": timestamp_ms,
        "timestamp": str(payload.get("timestamp") or ""),
        "fps": fps,
        "frameIdentifier": f"{video_name}_{frame_index}",
        "revision": 0,
        "submitted_by": username,
        "user_color": get_color_for_user(username),
        "isFromVideo": True,
    }
    try:
        result_code, result_data = await redis_async_client.eval(
            TRAKE_ASSIGN_SCRIPT,
            4,
            TRAKE_QUEUE_STATE_KEY,
            TRAKE_SLOT_REVISION_KEY,
            TRAKE_QUEUE_VIDEO_KEY,
            f"{TRAKE_REQUEST_PREFIX}{request_id}",
            str(event_number),
            video_name,
            json.dumps(frame),
        )
    except Exception as error:
        print(f"[TRAKE] Assign temporarily failed: request={request_id}, error={error}")
        await send_trake_message(websocket, "trake_retry", {
            "requestId": request_id,
            "eventNumber": event_number,
            "retryAfterMs": 1500
        })
        return
    result_code = int(result_code)
    if result_code == 2:
        frame = json.loads(result_data)
    elif result_code == 0:
        await send_trake_message(websocket, "trake_conflict", {
            "requestId": request_id,
            "eventNumber": event_number,
            "reason": "video_locked",
            "lockedVideoName": result_data
        })
        return
    else:
        frame = json.loads(result_data)

    print(f"[TRAKE] Assigned event={event_number}, frame={frame['frameIdentifier']}, user={username}")
    await send_trake_message(websocket, "trake_ack", {"requestId": request_id, "frame": frame})
    schedule_trake_broadcast(json.dumps({"action": "trake_slot_updated", "payload": frame}))


TRAKE_CLEAR_SCRIPT = """
local raw_frame = redis.call('HGET', KEYS[1], ARGV[1])
if not raw_frame then
    return {0, ''}
end
local frame = cjson.decode(raw_frame)
local current_revision = tonumber(frame.revision or 0)
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], current_revision)
if redis.call('HLEN', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[3])
end
return {1, raw_frame}
"""


async def clear_trake_slot(websocket: WebSocket, payload: dict):
    request_id = str(payload.get("requestId") or "")
    event_number = payload.get("eventNumber")
    try:
        event_number = int(event_number)
    except (TypeError, ValueError):
        event_number = 0
    if not request_id or event_number not in range(1, 6):
        return
    result_code, raw_frame = await redis_async_client.eval(
        TRAKE_CLEAR_SCRIPT,
        3,
        TRAKE_QUEUE_STATE_KEY,
        TRAKE_SLOT_REVISION_KEY,
        TRAKE_QUEUE_VIDEO_KEY,
        str(event_number),
    )
    result_code = int(result_code)
    print(f"[TRAKE] Cleared event={event_number}, deleted={result_code == 1}")
    await send_trake_message(websocket, "trake_ack", {
        "requestId": request_id,
        "eventNumber": event_number,
        "cleared": True
    })
    if result_code == 0:
        return
    schedule_trake_broadcast(json.dumps({
        "action": "trake_slot_cleared",
        "payload": {
            "requestId": request_id,
            "eventNumber": event_number,
            "revision": int(json.loads(raw_frame).get("revision", 0))
        }
    }))


def save_trake_thumbnail(image_bytes: bytes, output_path: Path):
    with Image.open(io.BytesIO(image_bytes)) as image:
        image = image.convert("RGB")
        image.thumbnail((160, 90), Image.Resampling.LANCZOS)
        temporary_path = output_path.with_suffix(".tmp")
        image.save(temporary_path, format="WEBP", quality=55, method=6)
        os.replace(temporary_path, output_path)


@app.post("/api/trake-thumbnail")
async def upload_trake_thumbnail(
    file: UploadFile = File(...),
    event_number: int = Form(...),
    video_name: str = Form(...),
    frame_index: int = Form(...),
    revision: int = Form(...),
    request_id: str = Form(...),
):
    if event_number not in range(1, 6):
        raise HTTPException(status_code=400, detail="Invalid TRAKE event number")
    frame_json = await redis_async_client.hget(TRAKE_QUEUE_STATE_KEY, str(event_number))
    if not frame_json:
        raise HTTPException(status_code=409, detail="TRAKE slot no longer exists")
    frame = json.loads(frame_json)
    if (
        frame.get("videoName") != video_name
        or int(frame.get("frameIndex", -1)) != frame_index
        or int(frame.get("revision", -1)) != revision
        or frame.get("requestId") != request_id
    ):
        raise HTTPException(status_code=409, detail="TRAKE slot changed before thumbnail upload")

    image_bytes = await file.read()
    if not image_bytes or len(image_bytes) > 1_000_000:
        raise HTTPException(status_code=400, detail="Thumbnail must be between 1 byte and 1 MB")
    filename = f"{hashlib.sha256(video_name.encode()).hexdigest()[:16]}_{frame_index}_{revision}.webp"
    output_path = TRAKE_THUMBNAIL_DIR / filename
    try:
        await asyncio.to_thread(save_trake_thumbnail, image_bytes, output_path)
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid thumbnail: {error}") from error

    thumbnail_path = f"/api/trake-thumbnail/{filename}"
    frame["thumbnailPath"] = thumbnail_path
    await redis_async_client.hset(TRAKE_QUEUE_STATE_KEY, str(event_number), json.dumps(frame))
    payload = {
        "eventNumber": event_number,
        "revision": revision,
        "thumbnailPath": thumbnail_path
    }
    await manager.publish_update(json.dumps({"action": "trake_slot_thumbnail_ready", "payload": payload}))
    return payload


@app.get("/api/trake-thumbnail/{filename}")
async def get_trake_thumbnail(filename: str):
    if not re.fullmatch(r"[a-f0-9]{16}_\d+_\d+\.webp", filename):
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    thumbnail_path = TRAKE_THUMBNAIL_DIR / filename
    if not thumbnail_path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(
        thumbnail_path,
        media_type="image/webp",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


@app.websocket("/ws/queue/{username}")
async def websocket_endpoint(websocket: WebSocket, username: str):
    await manager.connect(websocket, username)

    user_color = get_color_for_user(username)
    await redis_async_client.hset(QUEUE_USERS_KEY, username, user_color)

    sorted_identifiers = await redis_async_client.zrevrange(QUEUE_SORTED_SET_KEY, 0, -1)
    current_queue_items = []
    if sorted_identifiers:
        frame_data_list = await redis_async_client.hmget(QUEUE_DATA_HASH_KEY, sorted_identifiers)
        for item_json in frame_data_list:
            if item_json:
                current_queue_items.append(json.loads(item_json))

    current_users_raw = await redis_async_client.hgetall(QUEUE_USERS_KEY)
    current_users = dict(current_users_raw)
    wrong_ids = await redis_async_client.smembers("dres:wrong_submissions")
    initial_state = {
        "action": "init_state",
        "payload": {
            "queue": current_queue_items,
            "users": current_users,
            "wrongSubmissionIds": list(wrong_ids)
        }
    }
    manager.enqueue(websocket, json.dumps(initial_state), priority=0)

    join_notification = {
        "action": "user_update",
        "payload": {"users": current_users}
    }
    manager.enqueue(websocket, json.dumps({
        "action": "trake_init",
        "payload": await get_trake_queue_items()
    }), priority=0)
    await manager.publish_update(json.dumps(join_notification))
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            action = message.get("action")
            payload = message.get("payload")

            if action == "trake_assign":
                await assign_trake_slot(websocket, username, payload or {})
                continue
            if action in {"trake_clear", "clear_trake_event"}:
                print(f"[TRAKE] Clear request received: event={(payload or {}).get('eventNumber')}, user={username}")
                await clear_trake_slot(websocket, payload or {})
                continue
            if action == "clear_trake_queue":
                await redis_async_client.delete(
                    TRAKE_QUEUE_STATE_KEY,
                    TRAKE_QUEUE_VIDEO_KEY,
                    TRAKE_SLOT_REVISION_KEY,
                )
                await send_trake_message(websocket, "trake_ack", {"requestId": (payload or {}).get("requestId"), "cleared": True})
                await manager.publish_update(json.dumps({"action": "trake_init", "payload": []}))
                continue

            if action == "add_frames":
                frames_to_add = payload.get("frames", [])
                VOTE_PRIORITY_MULTIPLIER = 10**10
                pipe = redis_async_client.pipeline()
                special_frame_found = False
                for frame in frames_to_add:
                    identifier = frame.get("frameIdentifier")
                    if not identifier:
                        continue
                    if frame.get("isSpecial") is True:
                        special_frame_found = True

                    if await redis_async_client.hsetnx(QUEUE_DATA_HASH_KEY, identifier, json.dumps(frame)):
                        frame['added_by'] = username
                        frame['user_color'] = user_color
                        frame['voters'] = []
                        frame['vote_count'] = 0
                        frame['creation_time'] = time.time()
                        score = (frame['vote_count'] * VOTE_PRIORITY_MULTIPLIER) + frame['creation_time']
                        pipe.hset(QUEUE_DATA_HASH_KEY, identifier, json.dumps(frame))
                        pipe.zadd(QUEUE_SORTED_SET_KEY, {identifier: score})

                await pipe.execute()
                if special_frame_found:
                    alert_message = {
                        "action": "special_submission_alert",
                        "payload": {"username": username}
                    }
                    await manager.publish_update(json.dumps(alert_message))

            elif action == "report_dres_result":
                result_payload = payload
                submission_status = result_payload.get("status")
                frame_identifiers = result_payload.get("frameIdentifiers", [])

                if not frame_identifiers:
                    continue

                if submission_status == "WRONG":
                    await redis_async_client.sadd("dres:wrong_submissions", *frame_identifiers)
                    broadcast_message = {
                        "action": "dres_submission_wrong",
                        "payload": {
                            "submittedBy": username,
                            "frameIdentifiers": frame_identifiers
                        }
                    }
                    await manager.publish_update(json.dumps(broadcast_message))

                elif submission_status == "CORRECT":
                    await redis_async_client.delete("dres:wrong_submissions")
                    broadcast_message = {
                        "action": "dres_submission_correct",
                        "payload": {
                            "submittedBy": username,
                            "frameIdentifiers": frame_identifiers
                        }
                    }
                    await manager.publish_update(json.dumps(broadcast_message))

            elif action == "remove_frame":
                frame_to_remove = payload
                identifier_to_remove = frame_to_remove.get("frameIdentifier")
                if identifier_to_remove:
                    pipe = redis_async_client.pipeline()
                    pipe.zrem(QUEUE_SORTED_SET_KEY, identifier_to_remove)
                    pipe.hdel(QUEUE_DATA_HASH_KEY, identifier_to_remove)
                    await pipe.execute()

            elif action == "clear_all":
                await redis_async_client.delete(QUEUE_SORTED_SET_KEY, QUEUE_DATA_HASH_KEY, QUEUE_USERS_KEY)

            elif action == "vote_frame":
                identifier_to_vote = payload.get("frameIdentifier")
                if not identifier_to_vote:
                    continue

                item_json_str = await redis_async_client.hget(QUEUE_DATA_HASH_KEY, identifier_to_vote)

                if item_json_str:
                    item = json.loads(item_json_str)
                    voters = set(item.get("voters", []))
                    if username in voters:
                        voters.remove(username)
                    else:
                        voters.add(username)
                    item["voters"] = list(voters)
                    item["vote_count"] = len(voters)

                    VOTE_PRIORITY_MULTIPLIER = 10**10
                    creation_time = item.get('creation_time', time.time())
                    new_score = (item['vote_count'] * VOTE_PRIORITY_MULTIPLIER) + creation_time

                    pipe = redis_async_client.pipeline()
                    pipe.hset(QUEUE_DATA_HASH_KEY, identifier_to_vote, json.dumps(item))
                    pipe.zadd(QUEUE_SORTED_SET_KEY, {identifier_to_vote: new_score})
                    await pipe.execute()

            sorted_identifiers = await redis_async_client.zrevrange(QUEUE_SORTED_SET_KEY, 0, -1)
            updated_queue_items = []
            if sorted_identifiers:
                frame_data_list = await redis_async_client.hmget(QUEUE_DATA_HASH_KEY, sorted_identifiers)
                for item_json in frame_data_list:
                    if item_json:
                        updated_queue_items.append(json.loads(item_json))

            updated_users_raw = await redis_async_client.hgetall(QUEUE_USERS_KEY)
            updated_users = dict(updated_users_raw)

            full_update_message = {
                "action": "init_state",
                "payload": {
                    "queue": updated_queue_items,
                    "users": updated_users
                }
            }
            await manager.publish_update(json.dumps(full_update_message))

    except WebSocketDisconnect:
        manager.disconnect(username, websocket)


async def broadcast_trake_queue_update(send_to_specific_connection: Optional[WebSocket] = None):
    update_message = {
        "action": "trake_init",
        "payload": await get_trake_queue_items()
    }

    message_str = json.dumps(update_message)

    if send_to_specific_connection:
        manager.enqueue(send_to_specific_connection, message_str)
    else:
        await manager.publish_update(message_str)

class TrakeSubmitRequest(BaseModel):
    frames: List[dict]

@app.post("/api/trake-submit")
async def handle_trake_submit(request: TrakeSubmitRequest):
    """
    Placeholder để nhận dữ liệu cuối cùng từ TRAKE Submit Queue.
    """
    submitted_frames = request.frames
    print("--- NHẬN DỮ LIỆU SUBMIT TỪ TRAKE QUEUE ---")
    for frame in submitted_frames:
        print(f"  Event {frame.get('eventNumber')}: {frame.get('frameIdentifier')}")

    await redis_async_client.delete(
        TRAKE_QUEUE_STATE_KEY,
        TRAKE_QUEUE_VIDEO_KEY,
        TRAKE_SLOT_REVISION_KEY,
    )
    # Và broadcast một queue rỗng để cập nhật UI của mọi người
    await broadcast_trake_queue_update()

    return {"status": "success", "message": f"Received {len(submitted_frames)} frames for TRAKE submission."}


def _form_submit_directory() -> Path:
    directory = Path(FORM_SUBMIT_SAVE_PATH)
    directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve()


@contextmanager
def _locked_form_submit_directory():
    directory = _form_submit_directory()
    lock_path = directory / ".csv-manager.lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _resolve_form_submit_csv(directory: Path, filename: str, must_exist: bool = True) -> Path:
    if (
        not filename
        or filename != Path(filename).name
        or "/" in filename
        or "\\" in filename
        or Path(filename).suffix.lower() != ".csv"
    ):
        raise HTTPException(status_code=400, detail="Invalid CSV filename")

    path = directory / filename
    if path.resolve(strict=False).parent != directory:
        raise HTTPException(status_code=400, detail="Invalid CSV path")
    if path.is_symlink():
        raise HTTPException(status_code=400, detail="Symbolic links are not supported")
    if must_exist and (not path.is_file() or path.suffix.lower() != ".csv"):
        raise HTTPException(status_code=404, detail="CSV file not found")
    return path


def _normalize_form_submit_filename(filename: str) -> str:
    filename_base = re.sub(r'[\\/*?:"<>|]', "", filename.strip())
    if filename_base.lower().endswith(".csv"):
        filename_base = filename_base[:-4]
    filename_base = filename_base.strip()
    if not filename_base:
        raise HTTPException(status_code=400, detail="CSV filename cannot be empty")
    return f"{filename_base}.csv"


def _natural_filename_key(path: Path):
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"(\d+)", path.name)
    )


def _list_form_submit_csv_paths(directory: Path) -> List[Path]:
    return sorted(
        (
            path for path in directory.iterdir()
            if path.is_file() and not path.is_symlink() and path.suffix.lower() == ".csv"
        ),
        key=_natural_filename_key,
    )


def _content_revision(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_bytes_atomically(path: Path, content: bytes):
    temporary_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary_path.open("wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _append_csv_bytes(existing_content: bytes, new_content: bytes) -> bytes:
    if not existing_content:
        return new_content
    separator = b"" if existing_content.endswith((b"\n", b"\r")) else b"\n"
    return existing_content + separator + new_content


@app.get("/api/form-submit/files")
async def list_form_submit_files():
    try:
        with _locked_form_submit_directory() as directory:
            files = []
            for path in _list_form_submit_csv_paths(directory):
                content_bytes = path.read_bytes()
                try:
                    content = content_bytes.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise HTTPException(
                        status_code=422,
                        detail=f"CSV file is not valid UTF-8: {path.name}",
                    ) from error
                stat = path.stat()
                files.append({
                    "name": path.name,
                    "content": content,
                    "size": stat.st_size,
                    "modified_at": stat.st_mtime,
                    "revision": _content_revision(content_bytes),
                })
        return {"files": files, "count": len(files)}
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to read CSV files: {error}") from error


@app.put("/api/form-submit/files/{filename}")
async def update_form_submit_file(filename: str, request: FormSubmitFileUpdateRequest):
    if "\x00" in request.content:
        raise HTTPException(status_code=400, detail="CSV content cannot contain null bytes")

    try:
        with _locked_form_submit_directory() as directory:
            path = _resolve_form_submit_csv(directory, filename)
            current_content = path.read_bytes()
            if _content_revision(current_content) != request.revision:
                raise HTTPException(
                    status_code=409,
                    detail="CSV file changed after it was loaded. Refresh before saving.",
                )

            updated_content = request.content.encode("utf-8")
            _write_bytes_atomically(path, updated_content)
            stat = path.stat()

        return {
            "success": True,
            "file": {
                "name": path.name,
                "content": request.content,
                "size": stat.st_size,
                "modified_at": stat.st_mtime,
                "revision": _content_revision(updated_content),
            },
        }
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to update CSV file: {error}") from error


@app.delete("/api/form-submit/files/{filename}")
async def delete_form_submit_file(filename: str, revision: Optional[str] = Query(default=None)):
    try:
        with _locked_form_submit_directory() as directory:
            path = _resolve_form_submit_csv(directory, filename)
            if revision and _content_revision(path.read_bytes()) != revision:
                raise HTTPException(
                    status_code=409,
                    detail="CSV file changed after it was loaded. Refresh before deleting.",
                )
            path.unlink()
        return {"success": True, "filename": filename}
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to delete CSV file: {error}") from error


@app.get("/api/form-submit/download-all")
async def download_all_form_submit_files():
    try:
        archive_buffer = io.BytesIO()
        with _locked_form_submit_directory() as directory:
            csv_paths = _list_form_submit_csv_paths(directory)
            if not csv_paths:
                raise HTTPException(status_code=404, detail="No CSV files are available to download")

            with zipfile.ZipFile(archive_buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("submission/", b"")
                for path in csv_paths:
                    archive.writestr(f"submission/{path.name}", path.read_bytes())

        archive_buffer.seek(0)
        archive_name = f"csv-submissions-{time.strftime('%Y%m%d-%H%M%S')}.zip"
        return StreamingResponse(
            archive_buffer,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{archive_name}"'},
        )
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to create CSV archive: {error}") from error

@app.post("/api/form-submit")
async def handle_form_submit(request: FormSubmitRequest):
    """
    Nhận dữ liệu từ Form Submit Queue và tạo file CSV trên server.
    """
    try:
        safe_filename = _normalize_form_submit_filename(request.filename)
        csv_buffer = io.StringIO(newline='')
        writer = csv.writer(csv_buffer)

        # Trường hợp 1: User có nhập "answer"
        if request.answer and request.answer.strip():
            for frame_index in request.frame_indices:
                writer.writerow([request.video_name, frame_index, request.answer])
        # Trường hợp 2: User không nhập "answer"
        else:
            writer.writerow([request.video_name] + request.frame_indices)

        new_content = csv_buffer.getvalue().encode("utf-8")

        with _locked_form_submit_directory() as directory:
            filepath = _resolve_form_submit_csv(directory, safe_filename, must_exist=False)
            file_exists = filepath.exists()
            if file_exists and request.conflict_action == "error":
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "csv_exists",
                        "filename": safe_filename,
                        "message": "CSV file already exists",
                    },
                )

            if file_exists and request.conflict_action == "append":
                existing_content = filepath.read_bytes()
                try:
                    existing_content.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise HTTPException(
                        status_code=422,
                        detail=f"CSV file is not valid UTF-8: {safe_filename}",
                    ) from error
                content_to_write = _append_csv_bytes(existing_content, new_content)
                operation = "appended to"
            else:
                content_to_write = new_content
                operation = "overwritten" if file_exists else "created"

            _write_bytes_atomically(filepath, content_to_write)

        print(f"Form Submit data saved successfully to: {filepath}")
        return {
            "success": True,
            "filename": safe_filename,
            "operation": operation,
            "message": f"{safe_filename} {operation} successfully",
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"ERROR saving form submit data: {e}")

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to save data: {str(e)}")
static_dir = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/frontend"

if os.path.isdir(static_dir):
    app.mount("/aicweb", StaticFiles(directory=static_dir, html=True), name="static")
else:
    print("Static frontend directory not found; serving API endpoints only.")

# usage: python -m src.backend.api_server_service --database-url http://127.0.0.1:6090 --port 6080
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="AIC2026 Backend API Server using Database Service")
    parser.add_argument(
        "--database-url",
        "--db-url",
        default=os.getenv("DATABASE_SERVICE_URL", "http://127.0.0.1:6090"),
        help="URL of the Database Microservice",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host address to bind to (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=6080, help="Port to listen on (default: 6080)")
    parser.add_argument("--workers", type=int, default=1, help="Worker count (default: 1)")
    args, unknown = parser.parse_known_args()

    os.environ["DATABASE_SERVICE_URL"] = args.database_url
    print(
        f"Starting API Server Service on {args.host}:{args.port} "
        f"using database service '{args.database_url}'..."
    )
    uvicorn.run("src.backend.api_server_service:app", host=args.host, port=args.port, workers=args.workers, reload=False)
