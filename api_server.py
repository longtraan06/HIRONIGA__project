from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException, Depends, status, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from typing import Dict, List, Optional
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from src.core.database.milvus import MilvusManager
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
import aioredis
import asyncio
import fcntl
from contextlib import contextmanager
from pathlib import Path
FORM_SUBMIT_SAVE_PATH = "/mlcv2/WorkingSpace/Personal/chinhnm/LunchBox/Submited_results"

PROJECT_DIR = Path(__file__).resolve().parent
CLUSTER_CATALOG_FILE = Path("/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/core/clustering/hcm_noisy_frame_clustering/outputs/kmeans_image_k1000/clusters.json")
CLUSTER_DELETION_FILE = Path("/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/backend/Clustered/deleted_clusters.json")


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
)   

REDIS_URL = "redis://192.168.20.156:6060"
redis_async_client = aioredis.from_url(REDIS_URL, decode_responses=True)
keysframe_path_root = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/frames"
video_path_root = "/mlcv1/Datasets/HCMAI25/full"
hls_path = "/mlcv1/Datasets/HCMAI25/streaming/hls/"

"""
Available models:
"google/siglip2-large-patch16-512"
"google/siglip2-so400m-patch16-512"
"google/siglip2-so400m-patch16-naflex"
"google/siglip2-giant-opt-patch16-384"
"""

model_paths=[
    "google/siglip2-large-patch16-512",
]

milvus = MilvusManager(
                        host="192.168.20.150",
                        port='6050',
                        es_host=os.getenv("ES_HOST", "http://192.168.20.150:9250"),
                        model_paths=model_paths,
                        mode = 'AIC',
                        prefix=None
                    )


# clear cache method

# Thêm xác thực cơ bản
security = HTTPBasic()

# Thông tin đăng nhập admin (thay đổi thành thông tin của bạn)
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "hlgay"  # Thay đổi mật khẩu này!

@app.on_event("startup")
async def startup_event():
    pass

@app.on_event("shutdown")
async def shutdown_event():
    milvus.close()
    
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
        self.active_connections: Dict[str, WebSocket] = {}
        self.redis_pubsub_client = None
        self.listener_task = None

    async def connect(self, websocket: WebSocket, username: str):
        """Chấp nhận kết nối mới và khởi tạo listener nếu cần."""
        await websocket.accept()
        self.active_connections[username] = websocket
        
        # Chỉ khởi tạo một lần cho mỗi worker
        if self.redis_pubsub_client is None:
            self.redis_pubsub_client = await aioredis.from_url(REDIS_URL, decode_responses=True)
            self.listener_task = asyncio.create_task(self._pubsub_listener())

    def disconnect(self, username: str):
        """Ngắt kết nối của một user."""
        if username in self.active_connections:
            del self.active_connections[username]

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
                            # Lặp qua một bản sao của danh sách kết nối để tránh lỗi
                            living_connections = list(self.active_connections.values())
                            for connection in living_connections:
                                try:
                                    # Gửi tin nhắn đến từng client
                                    await connection.send_text(message["data"])
                                except Exception as e:
                                    # Nếu gửi lỗi (vd: client đã ngắt kết nối), chỉ in lỗi và tiếp tục
                                    print(f"Could not send message to a client: {e}")

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
    user_id: Optional[str] = None    # <<< THÊM VÀO
    query_id: Optional[str] = None 
    use_event_filter: Optional[bool] = False
    ocr_fuzzy: Optional[bool] = False
    asr_fuzzy: Optional[bool] = False
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
    query_id: Optional[str] = None 
    user_id: Optional[str] = None
    use_event_filter: Optional[bool] = False
    ocr_fuzzy: Optional[bool] = False
    asr_fuzzy: Optional[bool] = False
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
    return {"models": model_paths}


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
    results = milvus.search(
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
        asr=req.asr,
        use_event_filter=req.use_event_filter,
        user_filter=cluster_filter
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
    results = milvus.search(
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
        asr=req.asr,
        use_event_filter=req.use_event_filter,
        user_filter=cluster_filter
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
        model_name=model_name,
        use_tag=use_tag,
        top_k_tags=top_k_tags,
        use_event_filter=use_event_filter,
        cluster_filter_count=len(cluster_filter),
        uploaded_bytes=len(image_bytes),
        cluster_mode_enabled=cluster_mode_enabled,
    )
    
    # Gọi hàm search của Milvus với mode="image"
    results = milvus.search(
        query=image_bytes,
        mode="image",
        search_in="image",
        top_k=min(top_k, 1000),  # Giới hạn top_k
        model_name=model_name,
        use_tag=use_tag,            # <<< TRUYỀN THAM SỐ
        top_k_tags=top_k_tags,
        use_event_filter=use_event_filter,
        user_filter=cluster_filter
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
            milvus.clear_temporal_chain(user_id=user_id)
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
        
        initial_results = milvus.search(
            query=image_bytes,
            mode="image",
            search_in="image",
            start_temporal_chain=True,
            top_k=min(top_k, 1000),
            model_name=model_name,
            user_id=user_id,      # <<< THÊM VÀO
            query_id=query_id,
            use_event_filter=use_event_filter,
            user_filter=cluster_filter
        )
        
        return {
            "chain_id": chain_id,
            "initial_results": process_milvus_results_for_frontend(initial_results)
        }
        
    except Exception as e:
        
        traceback.print_exc()
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
        initial_results = milvus.search(
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
            asr = req.asr,
            user_id=req.user_id,    # <<< THÊM VÀO
            query_id=req.query_id,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            user_filter=cluster_filter
        )
        return {
            "chain_id": chain_id,
            "initial_results": process_milvus_results_for_frontend(initial_results)
        }
    
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
        temporal_answer = milvus.temporal_search_sequence(
            query=req.query,
            mode="text",
            top_k=min(req.top_k, 1000),
            use_tag=req.use_tag,
            top_k_tags=req.top_k_tags,
            tags_filter=req.tags_filter,
            ocr = req.ocr,
            asr = req.asr,
            user_id=req.chain_id,  # <<< THÊM VÀO (chain_id từ client chính là user_id)
            query_id=req.query_id,
            use_event_filter=req.use_event_filter,
            ocr_fuzzy=req.ocr_fuzzy,
            asr_fuzzy=req.asr_fuzzy,
            user_filter=cluster_filter
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
    
    except Exception as e:
        print(f"ERROR in temporal_search_continue: {str(e)}")
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
        chain_data = milvus.get_temporal_chain_for_frame(user_id, frame_identifier)
        if not chain_data:
             raise HTTPException(status_code=404, detail="Temporal chain not found for this frame.")
        return chain_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
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
    await websocket.send_text(json.dumps(initial_state))

    join_notification = {
        "action": "user_update",
        "payload": {"users": current_users}
    }
    await manager.publish_update(json.dumps(join_notification))
    await broadcast_trake_queue_update(send_to_specific_connection=websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            action = message.get("action")
            payload = message.get("payload")
            
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

            if action == "add_or_override_trake_frame":
                frame_data = payload
                event_number = str(frame_data.get("eventNumber"))

                if event_number:
                    frame_data['submitted_by'] = username
                    frame_data['user_color'] = get_color_for_user(username)
                    await redis_async_client.hset(TRAKE_QUEUE_STATE_KEY, event_number, json.dumps(frame_data))
                    await broadcast_trake_queue_update()

            elif action == "clear_trake_event":
                event_number_to_clear = str(payload.get("eventNumber"))
                if event_number_to_clear:
                    await redis_async_client.hdel(TRAKE_QUEUE_STATE_KEY, event_number_to_clear)
                    await broadcast_trake_queue_update()

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
        manager.disconnect(username)
        
        
async def broadcast_trake_queue_update(send_to_specific_connection: Optional[WebSocket] = None):
    all_trake_frames_raw = await redis_async_client.hgetall(TRAKE_QUEUE_STATE_KEY)
    
    trake_queue_items = []
    for event_num, frame_json in all_trake_frames_raw.items():
        try:
            frame_data = json.loads(frame_json)
            frame_data['eventNumber'] = int(event_num)
            trake_queue_items.append(frame_data)
        except (json.JSONDecodeError, ValueError):
            continue

    trake_queue_items.sort(key=lambda x: x.get('eventNumber', 0))

    update_message = {
        "action": "trake_queue_update",
        "payload": trake_queue_items
    }
    
    message_str = json.dumps(update_message)

    if send_to_specific_connection:
        await send_to_specific_connection.send_text(message_str)
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
    
    await redis_async_client.delete(TRAKE_QUEUE_STATE_KEY)
    # Và broadcast một queue rỗng để cập nhật UI của mọi người
    await broadcast_trake_queue_update()

    return {"status": "success", "message": f"Received {len(submitted_frames)} frames for TRAKE submission."}

@app.post("/api/form-submit")
async def handle_form_submit(request: FormSubmitRequest):
    """
    Nhận dữ liệu từ Form Submit Queue và tạo file CSV trên server.
    """
    try:
        # Đảm bảo thư mục lưu trữ tồn tại
        os.makedirs(FORM_SUBMIT_SAVE_PATH, exist_ok=True)

        # Tạo một tên file 
        safe_filename_base = re.sub(r'[\\/*?:"<>|]', "", request.filename)
        safe_filename = f"{safe_filename_base}.csv"

        filepath = os.path.join(FORM_SUBMIT_SAVE_PATH, safe_filename)

        with open(filepath, 'w', newline='', encoding='utf-8') as csvfile:
            writer = csv.writer(csvfile)

            # Trường hợp 1: User có nhập "answer"
            if request.answer and request.answer.strip():
                # Ghi header
                # writer.writerow(["video_id", "frame_index", "answer"])
                # Ghi mỗi frame trên một dòng
                for frame_index in request.frame_indices:
                    writer.writerow([request.video_name, frame_index, request.answer])
            
            # Trường hợp 2: User không nhập "answer"
            else:
                # Ghi tất cả trên một dòng
                row_data = [request.video_name] + request.frame_indices
                writer.writerow(row_data)

        print(f"Form Submit data saved successfully to: {filepath}")
        return {"success": True, "message": f"Data saved to {safe_filename}"}

    except Exception as e:
        print(f"ERROR saving form submit data: {e}")
        
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to save data: {str(e)}")
static_dir = "/workingspace_aiclub/WorkingSpace/Personal/chinhnm/AIC2026/src/frontend"

if os.path.isdir(static_dir):
    app.mount("/aicweb", StaticFiles(directory=static_dir, html=True), name="static")
else:
    print("Static frontend directory not found; serving API endpoints only.")

# usage uvicorn api_server:app --host 0.0.0.0 --port 80 --workers 1 --ws-ping-interval 5 --ws-ping-timeout 5
