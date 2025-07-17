from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
from milvus_indexing import MilvusManager
import tempfile
import os
import re
from PIL import Image
from fastapi import HTTPException
import time
import uuid
import asyncio  # Thêm import này
from pydantic import BaseModel
from fastapi.responses import FileResponse
from functools import lru_cache
import redis
from functools import wraps
import json
import hashlib
from fastapi import Depends, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
import secrets

app = FastAPI()
# Kết nối Redis
"""
Available models:
"google/siglip2-base-patch16-naflex"
"google/siglip2-base-patch16-512"
"jinaai/jina-clip-v2"
"google/siglip2-large-patch16-512"
"google/siglip2-so400m-patch16-384"
"google/siglip2-so400m-patch16-naflex"
"""
model_paths=[
    "google/siglip2-base-patch16-512",
    "jinaai/jina-clip-v2",
    "google/siglip2-large-patch16-512",
    # "google/siglip2-so400m-patch16-384",
            ]

milvus = MilvusManager(host="milvus-standalone",
                        port=19530,
                        model_paths=model_paths,
                        )
redis_client = redis.Redis(host='redis-server', port=6379, db=0)

# clear cache method

# Thêm xác thực cơ bản
security = HTTPBasic()

# Thông tin đăng nhập admin (thay đổi thành thông tin của bạn)
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "hlgay"  # Thay đổi mật khẩu này!

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

def get_keys_by_pattern(pattern):
       keys = []
       cursor = '0'
       while cursor != 0:
           cursor, partial_keys = redis_client.scan(cursor=cursor, match=pattern, count=100)
           keys.extend(partial_keys)
       return keys

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
            # Cẩn thận: Sẽ xóa TẤT CẢ keys trong Redis
            redis_client.flushall()
            return {"success": True, "message": "All Redis cache cleared", "count": "all"}
        
        deleted_count = 0
        
        if cache_type == "temporal" or cache_type == "all":
            # Xóa tất cả temporal chains
            pattern = "temporal_chain:*"
            keys = get_keys_by_pattern(pattern)
            if keys:
                deleted_count += redis_client.delete(*keys)
        
        if cache_type == "search" or cache_type == "all":
            # Xóa tất cả cache tìm kiếm
            # Giả định rằng các cache key của bạn đều có tiền tố "search_text:"
            pattern = "search_text:*"
            keys = redis_client.keys(pattern)
            if keys:
                deleted_count += redis_client.delete(*keys)
                
            # Thêm các mẫu cache khác nếu cần
            for func_name in ["get_video_info", "search_image"]:
                pattern = f"{func_name}:*"
                keys = redis_client.keys(pattern)
                if keys:
                    deleted_count += redis_client.delete(*keys)
        
        if cache_type == "rate_limit" or cache_type == "all":
            # Xóa tất cả rate limit counters
            pattern = "rate_limit:*"
            keys = redis_client.keys(pattern)
            if keys:
                deleted_count += redis_client.delete(*keys)
        
        return {
            "success": True,
            "message": f"Cleared {cache_type} cache from Redis",
            "deleted_count": deleted_count
        }
    
    except Exception as e:
        import traceback
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
        # Lấy thông tin Redis
        info = redis_client.info()
        
        # Đếm số lượng keys theo loại
        temporal_keys = len(redis_client.keys("temporal_chain:*"))
        search_cache_keys = len(redis_client.keys("search_text:*")) + len(redis_client.keys("get_video_info:*"))
        rate_limit_keys = len(redis_client.keys("rate_limit:*"))
        
        # Tổng số keys
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
# clear all cache: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=all
# clear temporal chains: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=temporal
# clear search cache: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=search
# clear rate limit counters: curl -X POST -u "admin:hlgay" http://localhost:34267/api/admin/clear-cache?cache_type=rate_limit
# get redis stats: curl http://192.168.20.156:8080/api/admin/redis-stats





# Định nghĩa decorator cache_result trước khi sử dụng
def cache_result(permanent=True, expire_time=300):  # Thêm tham số permanent
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Tạo cache key từ tên hàm và tham số
            cache_key = f"{func.__name__}:{hashlib.md5(str(args).encode() + str(kwargs).encode()).hexdigest()}"
            
            # Kiểm tra cache
            cached_result = redis_client.get(cache_key)
            if cached_result:
                return json.loads(cached_result)
            
            # Thực thi hàm nếu không có cache
            result = await func(*args, **kwargs)
            
            # Lưu kết quả vào cache
            if permanent:
                # Lưu vĩnh viễn, không có thời gian hết hạn
                redis_client.set(
                    cache_key,
                    json.dumps(result, default=str)
                )
            else:
                # Lưu với thời gian hết hạn
                redis_client.setex(
                    cache_key,
                    expire_time,
                    json.dumps(result, default=str)
                )
            
            return result
        return wrapper
    return decorator

# Models
class TemporalStartRequest(BaseModel):
    query: str
    top_k: int = 2000

class TemporalContinueRequest(BaseModel):
    query: str
    chain_id: str
    top_k: int = 2000

class TextSearchRequest(BaseModel):
    query: str
    top_k: int = 2000
    search_in: str = "image"
    start_temporal_chain: bool = False

class ImageSearchRequest(BaseModel):
    query: UploadFile
    top_k: int = 2000
    search_in: str = "image"
    start_temporal_chain: bool = False


@app.get("/api/debug/redis-test")
async def test_redis_connection():
    try:
        # Test kết nối Redis
        test_key = "test_connection"
        test_value = "working"
        redis_client.setex(test_key, 60, test_value)
        retrieved = redis_client.get(test_key)
        
        return {
            "status": "success",
            "message": "Redis connection is working",
            "test_value": retrieved.decode() if retrieved else None
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Redis connection failed: {str(e)}"
        }

@app.get("/api/debug/temporal-chain/{chain_id}")
async def debug_temporal_chain(chain_id: str):
    try:
        # Kiểm tra chain trong Redis
        chain_key = f"temporal_chain:{chain_id}"
        chain_data_str = redis_client.get(chain_key)
        
        if not chain_data_str:
            return {
                "exists": False,
                "message": "Chain not found in Redis"
            }
        
        # Thử parse JSON
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
                "raw_data_sample": chain_data_str[:100]  # First 100 chars
            }
    except Exception as e:
        return {
            "error": str(e)
        }

# Background task
# @app.on_event("startup")
# async def startup_event():
#     asyncio.create_task(cleanup_old_temporal_chains())

# async def cleanup_old_temporal_chains():
#     while True:
#         await asyncio.sleep(300)  # Run every 5 minutes
#         current_time = time.time()
        
#         # Lấy tất cả key temporal chain từ Redis
#         pattern = "temporal_chain:*"
#         all_keys = redis_client.keys(pattern)
        
#         for key in all_keys:
#             chain_id = key.decode('utf-8').replace("temporal_chain:", "")
#             chain_data_str = redis_client.get(key)
            
#             if chain_data_str:
#                 chain_data = json.loads(chain_data_str)
#                 if current_time - chain_data["last_update"] > 1800:  # 30 minutes
#                     # Xóa key khỏi Redis
#                     redis_client.delete(key)
#                     print(f"Cleaned up expired temporal chain: {chain_id}")

# API Routes
@app.get("/frames/{video_name}/{frame_name}")
async def get_frame(video_name: str, frame_name: str):
    frame_path = f"/workspace/WorkingSpace/Personal/chinhnm/final/{video_name}/{frame_name}"
    
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

@lru_cache(maxsize=100)
def get_video_info_cached(video_path: str):
    return {
        "exists": os.path.exists(video_path),
        "size": os.path.getsize(video_path) if os.path.exists(video_path) else 0
    }

@app.get("/videos/{video_name}")
async def get_video(video_name: str):
    video_path = f"/workspace/Datasets/HCMAI24/updated/videos/all/{video_name}"
    
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
    video_path = f"/workspace/Datasets/HCMAI24/updated/videos/all/{video_name}.mp4"
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
        video_dir = "/workspace/Datasets/HCMAI24/updated/videos/all"
        files = os.listdir(video_dir) if os.path.exists(video_dir) else []
        return {
            "exists": False,
            "path": video_path,
            "available_files": files[:10]  # Show first 10 files
        }

@app.post("/api/search/text")
@cache_result(expire_time=60)  # Cache 1 phút
async def search_text(req: TextSearchRequest):
    results = milvus.search(
        query=req.query,
        mode="text",
        search_in=req.search_in,
        top_k=min(req.top_k, 2000),  # Giới hạn top_k tối đa
        start_temporal_chain=False
    )
    return process_milvus_results_for_frontend(results)

@app.post("/api/search/image")
async def search_image(
    file: UploadFile = File(..., description="File ảnh để tìm kiếm"),
    top_k: int = Form(2000, description="Số lượng kết quả trả về")
):
    """
    Nhận một file ảnh, truyền nó vào Milvus để tìm kiếm các ảnh tương tự
    và trả về danh sách kết quả.
    """
    # Đọc nội dung của file ảnh dưới dạng bytes
    image_bytes = await file.read()
    
    # Gọi hàm search của Milvus với mode="image"
    results = milvus.search(
        query=image_bytes,
        mode="image",
        search_in="image",
        top_k=min(top_k, 2000)  # Giới hạn top_k
    )
    
    return process_milvus_results_for_frontend(results)


@app.get("/api/metadata/{video_id}")
async def get_frame_metadata(video_id: str):
    """
    Phục vụ file metadata.json cho một video cụ thể.
    """
    # Đường dẫn đến file metadata.json trên server
    metadata_path = f"/workspace/WorkingSpace/Personal/chinhnm/final/{video_id}/metadata.json"
    
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
        headers={
            # Bạn có thể cache file này để tăng tốc độ
            "Cache-Control": "public, max-age=3600",
        }
    )

@app.get("/api/video_info/{video_id}")
@cache_result(expire_time=3600)  # Cache 1 giờ
async def get_video_info(video_id: str):
    """
    API này sẽ đếm và liệt kê tất cả các file ảnh trong một thư mục video.
    """
    # THAY ĐỔI: Đường dẫn mới
    video_path = f"/workspace/WorkingSpace/Personal/chinhnm/final/{video_id}"
    
    if not os.path.isdir(video_path):
        raise HTTPException(status_code=404, detail="Video folder not found")
    
    try:
        # Lấy tất cả file .webp trong thư mục
        all_files = [f for f in os.listdir(video_path) if f.lower().endswith('.webp')]
        
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

import pickle
import base64

@app.post("/api/search/temporal/start")
async def temporal_search_start(req: TemporalStartRequest):
    try:
        # 1. Tạo một ID duy nhất cho chuỗi tìm kiếm này
        chain_id = str(uuid.uuid4())
        
        # 2. Thực hiện tìm kiếm đầu tiên (Query A) với tham số start_temporal_chain=True
        initial_results = milvus.search(
            query=req.query,
            mode="text",
            search_in="image",
            start_temporal_chain=True,
            top_k=min(req.top_k, 2000)  # Giới hạn top_k
        )
        
        # 3. Lấy trạng thái temporal
        temporal_state = milvus.temporal_state.copy() if hasattr(milvus, 'temporal_state') else None
        if not temporal_state:
            raise HTTPException(
                status_code=500, 
                detail="Failed to initialize temporal chain state"
            )
        
        # 4. Lưu trạng thái sử dụng pickle để giữ nguyên cấu trúc dữ liệu
        # Chuyển đổi thành binary và sau đó encode base64 để lưu vào Redis
        pickled_state = pickle.dumps(temporal_state)
        base64_state = base64.b64encode(pickled_state).decode('utf-8')
        
        temporal_chain_data = {
            "state_format": "pickle_base64",  # Đánh dấu định dạng dữ liệu
            "state": base64_state,
            "last_update": time.time()
        }
        
        redis_client.set(
            f"temporal_chain:{chain_id}",
            json.dumps(temporal_chain_data)
        )
        
        print(f"Started new temporal chain with ID: {chain_id}")
        
        # 5. Trả về kết quả và chain_id cho client
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
        chain_data_str = redis_client.get(f"temporal_chain:{req.chain_id}")
        
        if not chain_data_str:
            raise HTTPException(
                status_code=404, 
                detail="Temporal chain ID not found or expired."
            )
        
        # Parse JSON để lấy metadata
        chain_data = json.loads(chain_data_str)
        
        # 2. Khôi phục trạng thái temporal từ bộ nhớ lưu trữ
        if chain_data.get("state_format") == "pickle_base64":
            # Khôi phục từ pickle nếu dữ liệu được lưu dưới dạng pickle
            base64_state = chain_data["state"]
            pickled_state = base64.b64decode(base64_state)
            saved_state = pickle.loads(pickled_state)
        else:
            # Backwards compatibility - nếu dữ liệu lưu theo cách cũ
            saved_state = chain_data["state"]
        
        # 3. Cập nhật trạng thái temporal trong instance MilvusManager
        with milvus._lock:  # Sử dụng lock để tránh race condition
            milvus.temporal_state = saved_state
        
        # 4. Thực hiện temporal search sequence
        temporal_answer = milvus.temporal_search_sequence(
            query=req.query,
            mode="text",
            top_k=min(req.top_k, 2000)  # Giới hạn top_k
        )
        
        # 5. Lưu lại trạng thái mới sau khi thực hiện tìm kiếm
        with milvus._lock:
            saved_state = milvus.temporal_state.copy()
        
        # 6. Cập nhật trạng thái và thời gian trong Redis
        # Sử dụng pickle để lưu trạng thái
        pickled_state = pickle.dumps(saved_state)
        base64_state = base64.b64encode(pickled_state).decode('utf-8')
        
        temporal_chain_data = {
            "state_format": "pickle_base64",
            "state": base64_state,
            "last_update": time.time()
        }
        
        redis_client.set(
            f"temporal_chain:{req.chain_id}",
            json.dumps(temporal_chain_data)
        )
        
        print(f"Continued temporal chain with ID: {req.chain_id}")
        
        # 7. Xử lý kết quả trả về
        reranked_list = temporal_answer.get("query_A_reranked", [])
        processed_reranked_list = process_milvus_results_for_frontend(reranked_list)
        
        # 8. Tạo response cuối cùng
        current_query_results = process_milvus_results_for_frontend(
            temporal_answer.get("current_query_results", [])
        )
        
        return {
            "query_idx": temporal_answer.get("query_idx"),
            "current_query_results": current_query_results,
            "query_A_reranked": processed_reranked_list
        }
    
    except Exception as e:
        print(f"ERROR in temporal_search_continue: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def process_milvus_results_for_frontend(results: list) -> list:
    processed_list = []
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
        path = f"/frames/{video_name}/{full_frame_name}"  # Đường dẫn URL mới
        
        # Đường dẫn video giữ nguyên
        video_path = f"/videos/{video_name}.mp4"
        
        match = re.search(r'_(\d+)', frame_name)
        frame_id = int(match.group(1)) if match else 0
        
        frame_id_ori = metadata.get("frame_id", 0)  # Lấy frame_id từ metadata, mặc định là 0 nếu không có
        frame_identifier = f"{video_name}_{frame_id_ori}"

        processed_list.append({
            "id": frame_id,
            "path": path,  # Đường dẫn mới
            "videoName": video_name,
            "videoPath": video_path,
            "timestamp": metadata.get("timestamp", "00:00.000"),
            "score": res.get("score", res.get("sim_score", 0)),
            "temporal_score": res.get("temporal_score", 0),
            "frameIdentifier": frame_identifier
        })
    return processed_list

# def process_milvus_results_for_frontend(results: list) -> list:
#     processed_list = []
#     if not results:
#         return []
        
#     for res in results:
#         # Giờ đây, các trường cần thiết nằm trực tiếp trong 'res' hoặc 'res["metadata"]'
#         # tùy thuộc vào cách MilvusManager trả về. Giả định format bạn cung cấp.
#         metadata = res.get("entity", res.get("metadata", {})) # Tương thích với cả hai kiểu trả về

#         video_name = metadata.get("video_name")
#         if not video_name:
#              # Nếu không có video_name, ta không thể tạo đường dẫn hợp lệ.
#              # Có thể bỏ qua hoặc ghi log lỗi.
#              continue
        
#         frame_name = metadata.get("frame_name", "unknown_frame")
        
#         # Đảm bảo frame_name có đuôi .webp
#         full_frame_name = frame_name if frame_name.lower().endswith('.webp') else f"{frame_name}.webp"
        
#         # Đường dẫn URL để frontend có thể tải ảnh
#         frame_path_url = f"/frames/{video_name}/{full_frame_name}"
        
#         # Lấy frame_id, ưu tiên trường 'frame_id' bạn đã định nghĩa
#         frame_id = metadata.get("frame_id", 0)

#         processed_list.append({
#             "id": frame_id,  # Gửi frame_id cho frontend
#             "path": frame_path_url,
#             "videoName": video_name, # Gửi video_name cho frontend
#             "videoPath": f"/videos/{video_name}.mp4",
#             "timestamp": metadata.get("timestamp", "00:00.000"),
#             "score": res.get("distance", res.get("score", 0)), # 'distance' hoặc 'score' tùy thuộc vào Milvus
#             "temporal_score": res.get("temporal_score", None) # Gửi nếu có
#             # Thêm các trường khác nếu frontend cần
#         })
        
#     return processed_list


# Thêm rate limiting đơn giản
def rate_limit(limit=10, period=60):  # 10 requests/minute
    def decorator(func):
        @wraps(func)
        async def wrapper(request: Request, *args, **kwargs):
            client_ip = request.client.host
            key = f"rate_limit:{client_ip}:{func.__name__}"
            
            # Lấy số lượng request hiện tại
            current = redis_client.get(key)
            current = int(current) if current else 0
            
            if current >= limit:
                raise HTTPException(status_code=429, detail="Too many requests")
            
            # Tăng số lượng request và set TTL nếu chưa có
            pipe = redis_client.pipeline()
            pipe.incr(key)
            pipe.expire(key, period)
            pipe.execute()
            
            return await func(request, *args, **kwargs)
        return wrapper
    return decorator

# Mount static files
app.mount("/", StaticFiles(directory="web", html=True), name="static")

# usage uvicorn api_server:app --host 0.0.0.0 --port 80 --workers 4 --timeout-keep-alive 65
