from pymilvus import Collection, CollectionSchema, FieldSchema, DataType, connections, utility
import numpy as np
import torch
import os
os.environ["TOKENIZERS_PARALLELISM"] = "false" # <--- ADD THIS LINE
import json
from tqdm import tqdm
from PIL import Image
# from transform import load_image # Assuming this is not needed as logic is in the class
import time
import datetime
import math
import io
from transformers import AutoModel, AutoProcessor
from transformers.image_utils import load_image
from transformers import Siglip2Processor, Siglip2Model, SiglipModel, SiglipProcessor, CLIPProcessor, CLIPModel
from transformers import BitsAndBytesConfig
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from torch import autocast
import torch.multiprocessing as mp
import pandas as pd
try:
    # Pillow 9.0.0+
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:
    # Pillow < 9.0.0
    LANCZOS = Image.LANCZOS

# =============================================================================
# WORKER FUNCTIONS (FOR MULTI-GPU BUILD, UNCHANGED)
# =============================================================================
worker_model, worker_processor, worker_device = None, None, None

def gpu_worker_process(task_queue, result_queue, gpu_id, model_path):
    """
    The entire lifecycle of a single worker process running on one GPU.
    """
    print(f"Initializing worker PID {os.getpid()} on cuda:{gpu_id}")
    device = f"cuda:{gpu_id}"
    model, processor = None, None
    try:
        if "siglip" in model_path:
            model_class = Siglip2Model if "siglip2" in model_path else SiglipModel
            processor_class = Siglip2Processor if "siglip2" in model_path else SiglipProcessor
            model = model_class.from_pretrained(model_path, torch_dtype=torch.float16).to(device).eval()
            processor = processor_class.from_pretrained(model_path)
        elif "jina" in model_path:
            model = AutoModel.from_pretrained(
                model_path, 
                trust_remote_code=True, 
                torch_dtype=torch.float16
            ).to(device).eval()
            processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        else:
            raise ValueError(f"Model path {model_path} not supported for worker initialization.")

    except Exception as e:
        print(f"FATAL: Worker on GPU {gpu_id} failed to load model. Error: {e}")
        return

    while True:
        try:
            task_id, task_data = task_queue.get()
            if task_data is None: # Stop signal
                print(f"Worker on GPU {gpu_id} received stop signal.")
                break
            batch_frames, batch_texts, _ = task_data
            images = [Image.open(p).convert("RGB").resize((512, 512), LANCZOS) for p in batch_frames]
            image_inputs = processor(images=images, return_tensors="pt").to(device)
            text_inputs = processor(
                text=batch_texts, return_tensors="pt", padding="max_length", 
                truncation=True, max_length=64
            ).to(device)
            with torch.no_grad(), autocast("cuda", dtype=torch.float16):
                image_embeddings = model.get_image_features(**image_inputs).cpu().numpy()
                text_embeddings = model.get_text_features(**text_inputs).cpu().numpy()
            result_queue.put((task_id, image_embeddings, text_embeddings))
        except Exception as e:
            print(f"Worker on GPU {gpu_id} encountered an error: {e}. Skipping task.")
            result_queue.put((task_id, None, None))
            
class MilvusManager:
    def __init__(self, 
                 host="localhost", 
                 port="19530", 
                 model_paths: list = ["google/siglip2-base-patch16-512"],
                 num_build_workers=6,
):
        
        # Dictionaries to hold assets for each model
        self.models = {}
        self.processors = {}
        self.collections = {}
        self.AIC_collections = {}  # For AIC-specific collections
        self.ACM_collections = {}  # For ACM-specific collections
        self.embedding_dims = {}
        self.model_resolutions = {} 
        self.tag_collections = {}
        self.model_names = model_paths  # Store the list of model identifiers

        self.num_build_workers = num_build_workers
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._lock = threading.Lock()
        self._search_threads = 16
        self.metric_type = "COSINE"
        self.index_type = "HNSW"
        self.params = {"M": 16, "efConstruction": 200}

        connections.connect(alias="default", host=host, port=port)

        print(f"Initializing {len(self.model_names)} models...")
        # Sequentially load models to avoid VRAM OOM issues on a single GPU
        for model_path in self.model_names:
            self._load_model_and_init_collection(model_path)
            master_model_dim = self.embedding_dims[model_path]
            tag_collection_name = f"tags_shared_{model_path.split('/')[-1].replace('-','_')}"
            self._init_tag_collection(tag_collection_name, master_model_dim)
            self.tag_collections[model_path] = Collection(name=tag_collection_name)
            self.tag_collections[model_path].load()
        # Temporal state is singular and operates on aggregated results
        self.temporal_state = {}



    def _load_model_and_init_collection(self, model_path: str):
        print(f"--- Loading model: {model_path} ---")
        embedding_dim = 0
        collection_name = ""
        model_handle_name = model_path.split("/")[-1]
        use_amp = False
        if '384' in model_path:
            target_resolution = 384
        elif '224' in model_path:
            target_resolution = 224
        elif '512' in model_path:
            target_resolution = 512
        elif 'naflex' in model_path:
            target_resolution = None
        print(f"Target resolution for {model_handle_name}: {target_resolution}")
        if "siglip" in model_path:
            model_class = Siglip2Model if "naflex" in model_path else SiglipModel
            processor_class = Siglip2Processor if "naflex" in model_path else SiglipProcessor
            model = model_class.from_pretrained(model_path, device_map="auto", attn_implementation="sdpa", torch_dtype=torch.float16).eval()
            processor = processor_class.from_pretrained(model_path)
            
            if "large" in model_path: 
                embedding_dim = 1024
                collection_name= f'multimodal_index_siglip_large'
            elif "so400m" in model_path: 
                embedding_dim = 1152
                if "naflex" in model_path:
                    collection_name = 'multimodal_index_siglip_s40016_naflex'
                elif "384" in model_path:
                    collection_name= "multimodal_index_siglip_s40016"
                elif "512" in model_path:
                    collection_name= "multimodal_index_siglip_s40016_512"
            elif "giant" in model_path:
                embedding_dim = 1536
                if "naflex" in model_path:
                    collection_name = 'multimodal_index_siglip_giant_naflex'
                else:
                    collection_name = 'multimodal_index_siglip_giant'
            else: 
                embedding_dim = 768 # Base models
                if "naflex" in model_path:
                    collection_name= 'multimodal_index_siglip'
                else:
                    collection_name= 'multimodal_index_siglip_base'

            # collection_name = f'multimodal_index_siglip_{model_handle_name}'
            use_amp = True

        elif "jina" in model_path:
            model = AutoModel.from_pretrained(model_path, trust_remote_code=True, device_map='auto').half().eval()
            processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
            embedding_dim = 1024
            collection_name = f"multimodal_index_jina"
            use_amp = True

        elif "openai" in model_path:
            model = CLIPModel.from_pretrained(model_path, device_map='auto', torch_dtype=torch.float16).eval()
            processor = CLIPProcessor.from_pretrained(model_path)
            embedding_dim = 512 # Or 768 for large models
            collection_name = f"multimodal_index_clip_{model_handle_name}"
            use_amp = True

        else:
            raise ValueError(f"Unsupported model path: {model_path}")
        
        acm_collection_name = collection_name + "_ACM"
        # Store assets in dictionaries keyed by the model_path
        self.models[model_path] = model
        self.processors[model_path] = processor
        self.embedding_dims[model_path] = embedding_dim
        self.model_resolutions[model_path] = target_resolution # <--- STORE THE RESOLUTION
        # Initialize Milvus collection for this model
        self._init_milvus_collections(collection_name, dim=embedding_dim)
        self.AIC_collections[model_path] = Collection(name=collection_name)
        self.AIC_collections[model_path].load()
        self._init_milvus_collections(acm_collection_name, dim=embedding_dim)
        self.ACM_collections[model_path] = Collection(name=acm_collection_name)
        self.ACM_collections[model_path].load()
        print(f"--- Model {model_path} loaded. Collection: {collection_name}, Dim: {embedding_dim} ---")

    def _init_milvus_collections(self, collection_name, dim):
        if utility.has_collection(collection_name):
            print(f"Connecting to existing collection: '{collection_name}'")
            return
        fields = [
            FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
            FieldSchema(name="image_embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
            FieldSchema(name="text_embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
            FieldSchema(name="metadata", dtype=DataType.JSON),
        ]
        schema = CollectionSchema(fields, description="Unified multimodal index")
        collection = Collection(name=collection_name, schema=schema)
        index_params = {"metric_type": self.metric_type, "index_type": self.index_type, "params": self.params}
        collection.create_index(field_name="image_embedding", index_params=index_params)
        collection.create_index(field_name="text_embedding", index_params=index_params)
        print(f"Created new collection '{collection_name}' with indexes.")

    def _init_tag_collection(self, collection_name, dim):
        if utility.has_collection(collection_name):
            tag_collection = Collection(name=collection_name)
            print(f"Connected to existing tag collection: '{collection_name}'")
            return
        fields = [
            FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
            FieldSchema(name="tag_embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
            FieldSchema(name="tag_text", dtype=DataType.VARCHAR, max_length=512)
        ]
        schema = CollectionSchema(fields, description="Index for searchable tags")
        tag_collection = Collection(name=collection_name, schema=schema)
        index_params = {"metric_type": self.metric_type, "index_type": self.index_type, "params": self.params}
        tag_collection.create_index(field_name="tag_embedding", index_params=index_params)
        print(f"Created new tag collection: '{collection_name}'")
        
    def _prepare_inputs_for_model(self, inputs, model):
        """
        [DEFINITIVE VERSION] Intelligently prepares input tensors for a model loaded with device_map="auto".
        It finds the device of the first model parameter and moves the inputs there.
        This handles both sharded and non-sharded models correctly.
        """
        # The `model.device` property is not reliable for sharded models.
        # Instead, we find the device of the first parameter, which is where the input
        # is expected to be. This works for both single-device and sharded models.
        try:
            # `next(model.parameters())` gets the first layer's tensor, and `.device` gets its location.
            target_device = next(model.parameters()).device
            return inputs.to(target_device)
        except StopIteration:
            # This would happen if the model has no parameters, which is highly unlikely.
            # Fallback to the general device property if needed.
            return inputs.to(model.device)
        
    def encode_image(self, image_input, model_name: str):
        model = self.models[model_name]
        processor = self.processors[model_name]
        resolution = self.model_resolutions[model_name]
        # ... image loading logic ...
        if isinstance(image_input, str): image_pil = Image.open(image_input).convert("RGB")
        elif isinstance(image_input, bytes): image_pil = Image.open(io.BytesIO(image_input)).convert("RGB")
        elif isinstance(image_input, Image.Image): image_pil = image_input
        else: raise TypeError(f"Unsupported image input type: {type(image_input)}")
        image_pil = image_pil.resize((resolution, resolution), LANCZOS) if resolution else image_pil
        
        raw_inputs = processor(images=[image_pil], return_tensors="pt")#.to(self.device)
        inputs = self._prepare_inputs_for_model(raw_inputs, model)
        with torch.no_grad():
            emb = model.get_image_features(**inputs)
        return emb.cpu().numpy().squeeze()

    def encode_text(self, text, model_name: str):
        start = time.time()
        model = self.models[model_name]
        processor = self.processors[model_name]
        is_single_text = isinstance(text, str)
        if is_single_text: text = [text]
        
        raw_inputs = processor(text=text, return_tensors="pt", padding="max_length", truncation=True, max_length=64)
        # Use the new helper to correctly place the inputs
        inputs = self._prepare_inputs_for_model(raw_inputs, model)        
        with torch.no_grad():
            emb = model.get_text_features(**inputs)
        embeddings = emb.cpu().numpy()
        end = time.time()
        # print("Text encode time:", end - start)
        return embeddings[0] if is_single_text else embeddings

    def encode_image_batch(self, image_paths, model_name: str):
        start = time.time()
        if not image_paths: return np.array([])
        model = self.models[model_name]
        processor = self.processors[model_name]
        embedding_dim = self.embedding_dims[model_name]
        resolution = self.model_resolutions[model_name]
        # print("PEPARING WITH MODEL:", model)
        valid_images = []
        for path in image_paths:
            try:
                img = Image.open(path).convert("RGB").resize((resolution, resolution), LANCZOS) if resolution else Image.open(path).convert("RGB")
                valid_images.append(img)
            except Exception as e:
                print(f"WARNING: Could not load image '{path}'. Reason: {e}. Skipping.")
        if not valid_images: return np.array([]).reshape(0, embedding_dim)
        # print("ENCODING")
        raw_inputs = processor(images=valid_images, return_tensors="pt")#.to(self.device)
        inputs = self._prepare_inputs_for_model(raw_inputs, model)
        with torch.no_grad():
            emb = model.get_image_features(**inputs)
        emb = emb.cpu()
        # print("ENCODE SUCCESSFULLY")
        end = time.time()
        # print("Image encode time:", end-start)
        return emb.numpy()

    def encode_text_batch(self, texts, model_name: str):
        if not texts: return np.array([])
        # `encode_text` already handles lists efficiently
        return self.encode_text(texts, model_name)

    def insert_batch(self, model_name: str, image_embeddings=None, text_embeddings=None, metadatas=None):
        collection = self.collections[model_name]
        embedding_dim = self.embedding_dims[model_name]
        # ... (batch preparation logic is the same, but uses the specific collection and dim)
        batch_size = len(metadatas) if metadatas is not None else 0
        if batch_size == 0: return

        image_data = [emb.tolist() for emb in image_embeddings] if image_embeddings is not None else [np.zeros(embedding_dim).tolist()] * batch_size
        text_data = [emb.tolist() for emb in text_embeddings] if text_embeddings is not None else [np.zeros(embedding_dim).tolist()] * batch_size
        
        collection.insert([image_data, text_data, metadatas])

    def reset_collection(self, model_name: str):
        """Drop and recreate collection for a specific model."""
        if model_name not in self.collections:
            raise ValueError(f"Model '{model_name}' not found.")
        collection = self.collections[model_name]
        collection_name = collection.name
        dim = self.embedding_dims[model_name]
        if utility.has_collection(collection_name):
            utility.drop_collection(collection_name)
            print(f"Dropped existing collection: {collection_name}")
        self._init_milvus_collections(collection_name, dim=dim)
        self.collections[model_name] = Collection(name=collection_name) # Re-establish handle
        self.collections[model_name].load()
        print(f"Recreated collection for model '{model_name}'.")
        
    def reset_tag_collection(self):
        """
        Drops the existing shared tag collection and recreates it.
        This is useful for complete re-indexing of tags.
        """
        if not self.model_names:
            print("Cannot reset tag collection: No models initialized.")
            return

        if not hasattr(self, 'tag_collection'):
            print("Warning: Tag collection object does not exist. Attempting to initialize.")
            # Fallback to initialize it if it was never created
            master_model_name = self.model_names[0]
            master_model_dim = self.embedding_dims[master_model_name]
            tag_collection_name = f"tags_shared_{master_model_name.split('/')[-1].replace('-','_')}"
            self._init_tag_collection(tag_collection_name, master_model_dim)
            return

        collection_name = self.tag_collection.name
        
        print(f"Attempting to reset tag collection: '{collection_name}'")

        # Drop the collection if it exists
        if utility.has_collection(collection_name):
            try:
                # Release the collection from memory before dropping
                if self.tag_collection.has_index():
                    self.tag_collection.release()
                utility.drop_collection(collection_name)
                print(f"Successfully dropped existing tag collection: '{collection_name}'")
            except Exception as e:
                print(f"Error dropping tag collection '{collection_name}': {e}")
                # Don't proceed if dropping failed
                return
        else:
            print(f"Tag collection '{collection_name}' did not exist. A new one will be created.")

        # Re-initialize the collection
        # We need the dimension from the master model
        master_model_name = self.model_names[0]
        master_model_dim = self.embedding_dims[master_model_name]
        self._init_tag_collection(collection_name, master_model_dim)
        
        # Ensure the new collection is loaded into memory for use
        if hasattr(self, 'tag_collection') and utility.has_collection(self.tag_collection.name):
            self.tag_collection.load()
            print(f"Tag collection '{collection_name}' has been reset and loaded.")
            
    def build(self, data_root: str, metadata_path=None, model_name=None, image_batch_size=32, insert_batch_size=256, mode=None):
        """Builds the index for a *single specified model*."""
            
        if model_name and model_name not in self.model_names:
            raise ValueError(f"Model '{model_name}' was not initialized. Available models: {self.model_names}")
        print(f"--- Starting build process for model: {model_name} ---")
        if len(self.model_names) == 1:
            model_name=self.model_names[0]
        # Pass model_name down to the specific build implementation
        if mode == 'AIC':
            self.__build_keyframe_AIC(data_root, metadata_path, model_name, processing_batch_size=image_batch_size, insert_batch_size=insert_batch_size)
        elif mode == 'AIC_concurrent':
            # Multi-GPU build already takes model_name (as model_path)
            self._build_concurrent_multi_gpu(data_root, model_name, processing_batch_size=image_batch_size, insert_batch_size=insert_batch_size)
        # ... other build modes
        else:
            raise ValueError("Invalid mode. Choose 'AIC' or 'AIC_concurrent'.")
        
    def build_tag(self, tag_file_path=None, processing_batch_size=32, insert_batch_size=1024):
            """
            Builds the tag index from a file with batched processing and batched inserts.

            Args:
                tag_file_path (str): Path to the text file containing one tag per line.
                processing_batch_size (int): The number of tags to encode in a single pass.
                insert_batch_size (int): The number of encoded tags to buffer before inserting into Milvus.
            """
            if not os.path.exists(tag_file_path):
                print(f"Error: Tag file not found at {tag_file_path}")
                return

            print(f"Starting to build tag index from {tag_file_path}...")
            try:
                with open(tag_file_path, 'r', encoding='utf-8') as f:
                    tags = [line.strip() for line in f if line.strip()]
            except Exception as e:
                print(f"Error reading tag file: {e}")
                return

            if not tags:
                print("No tags found in the file.")
                return

            # --- START OF MODIFICATION: ADDING INSERT BATCHING ---

            # Buffers to hold data before inserting into Milvus
            insert_embedding_buffer = []
            insert_tag_buffer = []
            total_tags_processed = 0

            # Use the first initialized model for encoding all tags
            master_model_name = self.model_names[0]
            print(f"Using model '{master_model_name}' to encode tags.")
            
            # Loop through the tags in chunks for processing
            for i in tqdm(range(0, len(tags), processing_batch_size), desc="Encoding Tags"):
                batch_tags = tags[i:i + processing_batch_size]
                
                try:
                    # Encode the current batch of tags
                    batch_embeddings = self.encode_text_batch(batch_tags, model_name=master_model_name)
                    
                    # Add the processed results to our insert buffers
                    insert_embedding_buffer.extend(batch_embeddings.tolist())
                    insert_tag_buffer.extend(batch_tags)
                    
                    # Check if the insert buffer is full
                    if len(insert_embedding_buffer) >= insert_batch_size:
                        data_to_insert = [insert_embedding_buffer, insert_tag_buffer]
                        self.tag_collection.insert(data_to_insert)
                        total_tags_processed += len(insert_embedding_buffer)
                        
                        # Clear the buffers
                        insert_embedding_buffer = []
                        insert_tag_buffer = []

                except Exception as e:
                    print(f"\nError processing or inserting tag batch. Batch skipped. Error: {e}")
                    # Optionally, clear buffers here if you want to be safe
                    insert_embedding_buffer = []
                    insert_tag_buffer = []


            # After the loop, insert any remaining tags in the buffer
            if insert_embedding_buffer:
                try:
                    data_to_insert = [insert_embedding_buffer, insert_tag_buffer]
                    self.tag_collection.insert(data_to_insert)
                    total_tags_processed += len(insert_embedding_buffer)
                except Exception as e:
                    print(f"\nError inserting final tag batch: {e}")

            # --- END OF MODIFICATION ---

            self.tag_collection.flush()
            print(f"\nSuccessfully processed {total_tags_processed} of {len(tags)} tags.")
            print(f"Total entities in tag collection: {self.tag_collection.num_entities}")
            
    def _prepare_build_tasks(self, data_root, metadata, processing_batch_size):
        # This helper function is unchanged
        # ... (code from original)
        video_dirs = [os.path.join(data_root, d) for d in os.listdir(data_root) if os.path.isdir(os.path.join(data_root, d))]
        batch_frames, batch_texts, batch_metas = [], [], []
        video_dir_raw = "/workspace/Datasets/ACM2025/Batch1/video"
        for video_dir in video_dirs:
            video_name = os.path.basename(video_dir)
            if video_name not in metadata: continue
            metadata_4vid = metadata[video_name]
            # video_path = next((os.path.join(video_dir, f) for f in os.listdir(video_dir) if f.lower().endswith('.mp4')), None)
            video_path = None
            for f in os.listdir(video_dir_raw):
                if os.path.splitext(f)[0] == video_name:  # Get filename without extension
                    video_path = os.path.join(video_dir_raw, f)
                    break
            for f in os.listdir(video_dir):
                if not f.lower().endswith(('.jpg', '.webp')): continue
                frame_path = os.path.join(video_dir, f)
                frame_name = os.path.basename(frame_path).split('.')[0]
                if frame_name not in metadata_4vid: continue
                meta = metadata_4vid[frame_name]
                ocr_data = meta.get("ocr") # Get the raw OCR data
            
                full_text = "" # Initialize with a default empty string
                valid_text = None
                if isinstance(ocr_data, str):
                    # Format 2: It's a simple string
                    full_text = ocr_data.strip()
                    
                elif isinstance(ocr_data, dict):
                    # Format 1: It's a dictionary
                    # Safely get the list of texts, defaulting to an empty list
                    extracted_texts = ocr_data.get("extracted_texts", [])
                    
                    # Check if extracted_texts is a list and not empty
                    if extracted_texts and isinstance(extracted_texts, list):
                        # Join all text fragments with a newline for better context
                        full_text = "\n".join(text.strip() for text in extracted_texts).strip()
                    else:
                        channel_name = ocr_data.get("channel_name", "") or ""
                        main_news_text = ocr_data.get("main_news_text", "") or ""
                        thumb_nail_texr = ocr_data.get("thumbnail_text", "") or ""
                        time = ocr_data.get("time", "")
                        full_text = f'{channel_name}\n{main_news_text}\n{thumb_nail_texr}\n{time}'
                        valid_text = main_news_text + "\n" + thumb_nail_texr
                time_stamp_raw = meta.get("time-stamp")
                id_raw = meta.get("id")
                id_str = str(meta.get("id"))
                time_stamp = time_stamp_raw if time_stamp_raw != "00:00.000" else f'{id_str[0]}:{id_str[1:]}'
                frame_meta = {
                    "video_name": video_name, "video_path": video_path,
                    "frame_name": frame_name, "frame_path": frame_path,
                    "frame_id": id_raw, "shot": meta.get("shot"),
                    "timestamp": time_stamp_raw, #meta.get("time-stamp")
                    "tags": meta.get("tags", []),
                    "ocr": full_text
                }
                batch_frames.append(frame_path)
                batch_texts.append(valid_text if valid_text is not None else full_text)
                batch_metas.append(frame_meta)
                # print("DEBUG:", batch_frames[:5], batch_metas[:5], batch_texts[:5])
                if len(batch_frames) >= processing_batch_size:
                    yield (batch_frames, batch_texts, batch_metas)
                    batch_frames, batch_texts, batch_metas = [], [], []
        if batch_frames:
            yield (batch_frames, batch_texts, batch_metas)


    def _process_build_chunk(self, task_data, model_name: str):
        """Worker function with more robust error handling."""
        batch_frames, batch_texts, batch_metas = task_data
        try:
            image_embeddings = self.encode_image_batch(batch_frames, model_name)
        except Exception as e:
            print(f"\nERROR: Failed to encode image batch for model {model_name}. Skipping chunk. Error: {e}")
            # Return empty results so the main loop can skip it
            return None, None, None

        try:
            text_embeddings = self.encode_text_batch(batch_texts, model_name)
        except Exception as e:
            print(f"\nERROR: Failed to encode text batch for model {model_name}. Skipping chunk. Error: {e}")
            # Return empty results
            return None, None, None

        # Check if the number of embeddings matches the metadata
        if len(image_embeddings) != len(batch_metas) or len(text_embeddings) != len(batch_metas):
            print(f"\nWARNING: Mismatch in batch size for model {model_name} after encoding. "
                f"Metas: {len(batch_metas)}, Images: {len(image_embeddings)}, Texts: {len(text_embeddings)}. Skipping chunk.")
            return None, None, None

        return image_embeddings, text_embeddings, batch_metas

    def __build_keyframe_AIC(self, data_root, metadata_path, model_name: str, processing_batch_size=512, insert_batch_size=200):
        if metadata_path:
            metadata_path = metadata_path
        else:
            metadata_path = os.path.join(data_root, "metadata.json")
        with open(metadata_path, 'r') as f: metadata = json.load(f)
        
        insert_image_buffer, insert_text_buffer, insert_meta_buffer = [], [], []
        total_processed = 0

        with ThreadPoolExecutor(max_workers=self.num_build_workers) as executor:
            task_generator = self._prepare_build_tasks(data_root, metadata, processing_batch_size)
            # Use a lambda to pass the model_name to the processing function
            futures = [executor.submit(self._process_build_chunk, task, model_name) for task in task_generator]
            for future in tqdm(as_completed(futures), total=len(futures), desc="Processing Chunks"):
                # print("DEBUG")
                try:
                    img_embs, txt_embs, metas = future.result()
                    insert_image_buffer.extend(img_embs)
                    insert_text_buffer.extend(txt_embs)
                    insert_meta_buffer.extend(metas)
                    if len(insert_image_buffer) >= insert_batch_size:
                        self.insert_batch(model_name, insert_image_buffer, insert_text_buffer, insert_meta_buffer)
                        insert_image_buffer, insert_text_buffer, insert_meta_buffer = [], [], []
                except Exception as e:
                    print(f"\nERROR: A processing chunk failed: {e}")
        
        if insert_image_buffer:
            self.insert_batch(model_name, insert_image_buffer, insert_text_buffer, insert_meta_buffer)
        
        self.collections[model_name].flush()
        print(f"Build completed. Total entities in collection: {self.collections[model_name].num_entities}")
    
    def _build_concurrent_multi_gpu(self, data_root, model_name: str, processing_batch_size, insert_batch_size):
        # This method's logic is largely the same, as the `gpu_worker_process`
        # is already designed to be independent and takes the model_path (model_name).
        # The key change is ensuring insert_batch uses the correct collection.
        # ... (setup code for queues, tasks, workers)
        num_gpus = torch.cuda.device_count()
        task_queue, result_queue = mp.Queue(), mp.Queue()
        metadata_path = os.path.join(data_root, "merged_metadata_1.json")
        with open(metadata_path, 'r') as f: metadata = json.load(f)
        all_tasks = list(self._prepare_build_tasks(data_root, metadata, processing_batch_size))
        metadata_map = {i: task[2] for i, task in enumerate(all_tasks)}
        for i, task in enumerate(all_tasks): task_queue.put((i, task))
        for _ in range(num_gpus): task_queue.put((-1, None))
        
        workers = [mp.Process(target=gpu_worker_process, args=(task_queue, result_queue, gpu_id, model_name)) for gpu_id in range(num_gpus)]
        for w in workers: w.start()
        
        insert_image_buffer, insert_text_buffer, insert_meta_buffer = [], [], []
        for _ in tqdm(range(len(all_tasks)), desc="Processing on Multi-GPU"):
            task_id, img_embs, txt_embs = result_queue.get()
            if img_embs is None: continue
            metas = metadata_map[task_id]
            insert_image_buffer.extend(img_embs)
            insert_text_buffer.extend(txt_embs)
            insert_meta_buffer.extend(metas)
            if len(insert_image_buffer) >= insert_batch_size:
                self.insert_batch(model_name, insert_image_buffer, insert_text_buffer, insert_meta_buffer)
                insert_image_buffer, insert_text_buffer, insert_meta_buffer = [], [], []
        
        for w in workers: w.join()
        if insert_image_buffer:
            self.insert_batch(model_name, insert_image_buffer, insert_text_buffer, insert_meta_buffer)

        self.collections[model_name].flush()
        print(f"Build completed. Total entities in collection: {self.collections[model_name].num_entities}")
    def _flatten_model_results(self, model_name, hits):
        """
        A helper function to be run in a thread.
        It processes one model's results and returns a flat list of records.
        """
        records = []
        for i, hit in enumerate(hits):
            key = hit['metadata'].get('frame_path')
            if not key:
                continue
            records.append({
                'frame_path': key,
                'rank': i + 1,
                'metadata': hit['metadata']
            })
        return records   
    def _single_model_search(self, query, model_name: str, mode="text", search_in='image', top_k=50, expr=None, precomputed_vector=None):
        """Performs a search using a single, specified model, optionally with a pre-computed vector."""
        start = time.time()
        
        if precomputed_vector is not None:
            query_vector = precomputed_vector
        else:
            if mode == "text":
                query_vector = self.encode_text(query, model_name=model_name)
            else: # "image"
                query_vector = self.encode_image(query, model_name=model_name)
        
        anns_field = 'text_embedding' if search_in == 'text' else 'image_embedding'
        collection = self.collections[model_name]
        
        search_param = {"params": self._get_hnsw_search_param(top_k)}
        results = collection.search(
            data=[query_vector.tolist()], anns_field=anns_field,
            param=search_param, limit=top_k, output_fields=["metadata"], expr=expr
        )
        end = time.time()
        print(f"Searching time with {model_name}:", end-start)
        formatted_results = [{"metadata": hit.entity.get("metadata"), "score": hit.distance} for hit in results[0]] if results and results[0] else []
        return formatted_results

    def _perform_multi_model_search(self, query, mode="text", search_in='image', top_k=50, expr: str = None, precomputed_vectors=None):
        """
        The core search engine, using a highly optimized vectorized approach (Pandas)
        to rerank the combined result by rank.
        """
        if precomputed_vectors is None:
            precomputed_vectors = {}

        start = time.time()
        model_specific_results = {}
        # num_workers = min(6, os.cpu_count() or 1) 
        with ThreadPoolExecutor(max_workers=len(self.models)) as executor:
            futures = {
                executor.submit(self._single_model_search, query, model_name, mode, search_in, top_k, expr, precomputed_vectors.get(model_name)): model_name
                for model_name in self.model_names
            }
            for future in as_completed(futures):
                model_name = futures[future]
                try:
                    model_specific_results[model_name] = future.result()
                except Exception as exc:
                    print(f'{model_name} generated an exception during search: {exc}')

        if not model_specific_results:
            return []
        end = time.time()
        print(f"Searching time for all models: {end-start:.4f}s")

        # --- OPTIMIZED AGGREGATION USING PANDAS ---
        start_agg = time.time()

        # Step 1: Flatten all results into a single list for the DataFrame
        all_ranks_data = []
        for model_name, hits in model_specific_results.items():
            for i, hit in enumerate(hits):
                key = hit['metadata'].get('frame_path')
                if not key:
                    continue
                # Each record contains the unique ID, its rank for this model, and its metadata
                all_ranks_data.append({
                    'frame_path': key,
                    'rank': i + 1,  # 1-based rank
                    'metadata': hit['metadata']
                })
        
        if not all_ranks_data:
            return []

        # Step 2: Create a DataFrame
        df = pd.DataFrame(all_ranks_data)

        # Step 3: Vectorized calculation of rank_score for all rows at once
        N = float(top_k)
        df['rank_score'] = 1.0 - ((df['rank'] - 1) / N)

        # Step 4: Group by frame_path and aggregate. This is the magic step.
        # - Sum the 'rank_score' for each group.
        # - Keep the 'metadata' from the first time we saw each frame.
        aggregated_df = df.groupby('frame_path').agg(
            score=('rank_score', 'sum'),
            metadata=('metadata', 'first')
        )

        # Step 5: Sort the results by the new aggregated score
        final_df = aggregated_df.sort_values('score', ascending=False)
        
        # Convert the DataFrame back to the desired list of dictionaries format
        final_list = final_df.reset_index().to_dict('records')
        
        end_agg = time.time()
        print(f"Vectorized Reranking Time: {end_agg - start_agg:.4f}s")

        return final_list[:top_k]
        
    def _search_tag_with_vector(self, query_vector, top_k=5, tag_master_model=None):
        """Private helper to search tags using a pre-computed vector."""
        # if not hasattr(self, 'tag_collection'):
        #     raise Exception("Tag collection is not initialized.")
        tag_collection = self.tag_collections[tag_master_model] 
        search_params = {"metric_type": self.metric_type, "params": {"ef": 32}}
        results = tag_collection.search(
            data=[query_vector.tolist()],
            anns_field="tag_embedding",
            param=search_params,
            limit=top_k,
            output_fields=["tag_text"]
        )
        
        found_tags = [hit.entity.get("tag_text") for hit in results[0]] if results and results[0] else []
        return found_tags
    
    def search(self, query, mode="text", search_in='image', top_k=50, start_temporal_chain=False, 
               model_name: str = None, base_expr: str = None, database_mode= 'AIC',
               tags_filter=None, use_tag=False, top_k_tags=5, tags_filter_mode='any', ocr=None):
        """
        [NEW & IMPROVED] Performs a search using a specific model or all models,
        with integrated support for tag filtering.

        Args:
            ... (standard args) ...
            tags_filter (list, optional): A manual list of tags to filter by.
            use_tag (bool, optional): If True, dynamically finds relevant tags from the query.
            top_k_tags (int, optional): The number of dynamic tags to find.
            tags_filter_mode (str, optional): 'any' or 'all' for tag filtering logic.
        """
        if model_name and model_name not in self.model_names:
            raise ValueError(f"Model '{model_name}' not initialized. Available models: {self.model_names}")
        if len(self.model_names) == 1:
            model_name = self.model_names[0]
        if database_mode == 'ACM':
            print("Using ACM collections for search.")
            self.collections = self.ACM_collections
        elif database_mode == 'AIC':
            print("Using AIC collections for search.")
            self.collections = self.AIC_collections
        else:
            raise ValueError("Invalid collections. Please choose AIC or ACM.")
        # --- 1. Tag and Expression Logic ---
        expressions = []
        
        if base_expr:
            expressions.append(f"({base_expr})")

        # --- Tag Filtering Logic ---
        final_tags = tags_filter
        query_vector_map = {} # To store pre-computed vectors
        if not final_tags and use_tag:
            print(f"Dynamically searching for top {top_k_tags} tags...")
            tag_master_model = model_name or self.model_names[0]
            query_vector = self.encode_text(query, tag_master_model) if mode == "text" else self.encode_image(query, tag_master_model)
            query_vector_map[tag_master_model] = query_vector
            dynamic_tags = self._search_tag_with_vector(query_vector, top_k=top_k_tags, tag_master_model=tag_master_model)
            if dynamic_tags:
                print(f"Found dynamic tags for filtering: {dynamic_tags}")
                final_tags = dynamic_tags

        if final_tags:
            formatted_tags_json_array = json.dumps(final_tags)
            op = "json_contains_any" if tags_filter_mode == 'any' else "json_contains_all"
            tag_expr = f"json_contains_any(metadata['tags'], {formatted_tags_json_array})"
            expressions.append(f"({tag_expr})")

        # --- ACTION 2: OCR Filtering Logic ---
        if ocr:
            # Sanitize input to prevent issues. Basic escaping for quotes.
            sanitized_text = ocr.replace('\\', '\\\\').replace('"', '\\"')
            ocr_expr = f'metadata["ocr"] like "%{sanitized_text}%"'
            print(f"Applying OCR filter: {ocr_expr}")
            expressions.append(f"({ocr_expr})")

        # --- Combine all expressions ---
        final_expr = " and ".join(expressions) if expressions else None


        # --- 2. Search Execution ---
        final_list = []
        if model_name:
            # --- SINGLE MODEL SEARCH PATH ---
            print(f"Performing search with single model: {model_name}")
            # Check if we already have the vector
            precomputed_vector = query_vector_map.get(model_name)
            final_list = self._single_model_search(query, model_name, mode, search_in, top_k, final_expr, precomputed_vector=precomputed_vector)
        else:
            # --- MULTI-MODEL SEARCH PATH (DEFAULT) ---
            print("Performing search with all available models.")
            final_list = self._perform_multi_model_search(query, mode, search_in, top_k, final_expr, precomputed_vectors=query_vector_map)

        # --- 3. Final Processing ---
        if not final_list:
             if start_temporal_chain:
                print("Warning: Initial query A yielded no results.")
             return []

        if start_temporal_chain:
            self._init_temporal_state(query, mode, final_list, model_name)
        
        return self._convert_numpy_to_python(final_list)
    

    def _init_temporal_state(self, query, mode, results, model_name=None):
        """
        [UPDATED] Initializes the temporal state, now storing the model context.
        """
        with self._lock:
            initial_A_results = [{"metadata": item["metadata"], "original_score": item["score"], "temporal_score": item["score"]} for item in results]
            self.temporal_state = {
                "query_history": [{"query": query, "mode": mode}],
                "query_results": {0: initial_A_results}, 
                "videos_in_chain": list(set([item["metadata"]["video_name"] for item in results if "video_name" in item["metadata"]])),
                "query_A_reranked": initial_A_results,
                "model_context": model_name or "all" # Store 'all' or the specific model_name
            }
        print(f"Temporal chain initialized using model(s): '{self.temporal_state['model_context']}'. Found {len(self.temporal_state['videos_in_chain'])} relevant videos.")

    def temporal_search_sequence(self, query, mode="text", search_in='image', top_k=5, temporal_threshold=0,
                                 top_k_tags=5, use_tag=False, tags_filter_mode='any', tags_filter=None, ocr=None):
        """
        [SIMPLIFIED] Handles subsequent temporal searches by building the video filter
        and passing all other parameters down to the main `search` method.
        """
        if not self.temporal_state.get("query_history"):
            raise ValueError("Temporal search chain not initialized.")
        
        state = self.temporal_state
        model_context = state.get("model_context")
        model_name_for_search = model_context if model_context != "all" else None
        current_query_idx = len(state["query_history"])
        
        print(f"--- Performing Temporal Search (Query {chr(65 + current_query_idx)}) using model(s): '{model_context}' ---")

        # Step 1: Build ONLY the video filter expression.
        videos_in_chain = state.get("videos_in_chain", [])
        if not videos_in_chain:
            print("Warning: No videos in chain. Aborting.")
            return self._convert_numpy_to_python({"query_A_reranked": state.get("query_A_reranked", []), "current_query_results": [], "removed_frames_count": 0})
        
        # Corrected Milvus JSON expression format
        video_list_str = '","'.join(videos_in_chain)
        video_filter_expr = f'metadata["video_name"] in ["{video_list_str}"]'

        
        # Step 2: Call the main `search` method, passing the video filter as `base_expr`
        # and all tag parameters directly. `search` will handle the logic.
        current_query_results_raw = self.search(
            query, 
            mode=mode, 
            search_in=search_in, 
            top_k=top_k, 
            model_name=model_name_for_search,
            base_expr=video_filter_expr,
            tags_filter=tags_filter,
            use_tag=use_tag,
            top_k_tags=top_k_tags,
            tags_filter_mode=tags_filter_mode,
            ocr=ocr,
            start_temporal_chain=False # Never start a new chain mid-sequence
        )

        # Step 3: Process results and rerank (unchanged)
        if not current_query_results_raw:
            print("Subsequent query found no relevant frames with the given filters.")
            return self._convert_numpy_to_python({"query_idx": current_query_idx, "query_A_reranked": state["query_A_reranked"], "current_query_results": [], "removed_frames_count": 0})
        
        current_query_results = [{"metadata": h["metadata"], "original_score": h["score"], "temporal_score": h["score"]} for h in current_query_results_raw]
        with self._lock:
            state["query_history"].append({"query": query, "mode": mode})
            state["query_results"][current_query_idx] = current_query_results

        prev_query_idx = current_query_idx - 1
        start = time.time()
        reranked_A, removed_count = self._rerank_query_A(prev_query_idx, current_query_idx, temporal_threshold)
        end = time.time()
        print("Temporal score computing time:", end - start)
        
        with self._lock:
            state["query_A_reranked"] = reranked_A
            
        final_result = {"query_idx": current_query_idx, "query_A_reranked": reranked_A, "current_query_results": current_query_results, "removed_frames_count": removed_count}
        return self._convert_numpy_to_python(final_result)
    
    def _convert_numpy_to_python(self, data):
        """
        Recursively traverses a data structure and converts NumPy numeric types
        to native Python types for JSON serialization.
        """
        if isinstance(data, dict):
            # If it's a dictionary, recurse on each value
            return {key: self._convert_numpy_to_python(value) for key, value in data.items()}
        elif isinstance(data, list):
            # If it's a list, recurse on each item
            return [self._convert_numpy_to_python(item) for item in data]
        elif isinstance(data, (np.floating, np.integer)):
            # If it's a NumPy float or integer, convert it to a Python native type
            return data.item()
        elif isinstance(data, np.ndarray):
            # If it's a NumPy array, convert it to a list
            return data.tolist()
        else:
            # Otherwise, return the item as is
            return data
        
    # --- Other helper methods (compute_temporal_score, _rerank_query_A, etc.) are unchanged ---
    # They are called by the new temporal search logic and will work correctly.
    def _compute_temporal_score_vectorized(self, ts_A, sim_A, ts_B, sim_B, 
                                           threshold_maximum=300, threshold_alpha=60.0,
                                           weight_A=0.5, weight_lamda=0.8, weight_gamma=1.0, 
                                           mode: int = 2):
        """
        [NEW VECTORIZED] Computes temporal scores for entire arrays/matrices of keyframes at once.
        All inputs (ts_A, sim_A, etc.) are expected to be NumPy arrays.
        """
        # Calculate pairwise distances. This works if inputs are vectors or matrices.
        distance = np.abs(ts_A - ts_B)
        
        # Calculate penalty using NumPy functions
        if mode == 2: # exponential
            penalty = weight_lamda * (1 - np.exp(-weight_gamma * distance / threshold_alpha))
        else: # linear
            penalty = weight_lamda * np.minimum(distance / threshold_alpha, 1.0)
            
        # Calculate the base similarity score
        base_similarity = (weight_A * sim_A + (1 - weight_A) * sim_B)
        
        # Apply penalty
        final_scores = base_similarity * (1 - penalty)
        
        # Apply the maximum distance threshold by setting scores to 0 where distance is too great
        final_scores[distance >= threshold_maximum] = 0
        
        return final_scores


# =============================================================================
# ACTION 2: REPLACE these methods for a much more scalable temporal search
# =============================================================================

    def _rerank_query_A(self, prev_query_idx, current_query_idx, temporal_threshold):
        """
        [ULTRA-OPTIMIZED & CLEAN] Reranks Query A using vectorized NumPy operations 
        and calls the new vectorized scoring function.
        """
        state = self.temporal_state
        if prev_query_idx not in state["query_results"] or current_query_idx not in state["query_results"]:
            return state.get("query_A_reranked", []), 0

        # --- 1. Data Preparation (Unchanged) ---
        def to_structured_array(results):
            if not results:
                return np.array([], dtype=[('video_name', 'U20'), ('timestamp', 'f4'), ('original_score', 'f4'), ('temporal_score', 'f4'), ('id', 'i4')])
            def to_seconds(ts):
                parts = str(ts).split(':'); return float(parts[0]) * 60 + float(parts[1])
            return np.array([(r['metadata']['video_name'], to_seconds(r['metadata']['timestamp']), r['original_score'], r['temporal_score'], i) 
                             for i, r in enumerate(results)], dtype=[('video_name', 'U20'), ('timestamp', 'f4'), ('original_score', 'f4'), ('temporal_score', 'f4'), ('id', 'i4')])

        original_A_results = state["query_A_reranked"]
        a_data = to_structured_array(original_A_results)
        prev_data = to_structured_array(state["query_results"][prev_query_idx])
        current_data = to_structured_array(state["query_results"][current_query_idx])
        new_a_temporal_scores = np.copy(a_data['temporal_score'])
        unique_videos = np.unique(a_data['video_name'])
        is_first_rerank = (prev_query_idx == 0)

        # --- 2. Vectorized Processing Loop (per video) ---
        for vid in unique_videos:
            mask_a = (a_data['video_name'] == vid)
            mask_prev = (prev_data['video_name'] == vid)
            mask_current = (current_data['video_name'] == vid)

            if not np.any(mask_prev) or not np.any(mask_current):
                new_a_temporal_scores[mask_a] *= 0.1
                continue

            a_vid_data = a_data[mask_a]
            prev_vid_data = prev_data[mask_prev]
            current_vid_data = current_data[mask_current]

            if is_first_rerank: # A -> B
                # Use the vectorized scoring function for A->B
                score_matrix = self._compute_temporal_score_vectorized(
                    ts_A=a_vid_data['timestamp'][:, None],
                    sim_A=a_vid_data['original_score'][:, None],
                    ts_B=current_vid_data['timestamp'],
                    sim_B=current_vid_data['original_score']
                )
                best_a_to_b_scores = np.max(score_matrix, axis=1)
                new_a_temporal_scores[mask_a] = (a_vid_data['temporal_score'] + best_a_to_b_scores) / 2.0
            
            else: # B -> C
                # Use the vectorized scoring function for B->C
                score_matrix_bc = self._compute_temporal_score_vectorized(
                    ts_A=prev_vid_data['timestamp'][:, None],
                    sim_A=prev_vid_data['temporal_score'][:, None],
                    ts_B=current_vid_data['timestamp'],
                    sim_B=current_vid_data['temporal_score']
                )
                
                if score_matrix_bc.size == 0 or np.max(score_matrix_bc) == 0:
                    new_a_temporal_scores[mask_a] *= 0.1
                    continue
                
                best_link_score = np.max(score_matrix_bc)
                best_b_index = np.unravel_index(np.argmax(score_matrix_bc), score_matrix_bc.shape)[0]
                best_prev_hit = prev_vid_data[best_b_index]

                # Use the vectorized scoring function for A -> best_B
                a_to_best_b_scores = self._compute_temporal_score_vectorized(
                    ts_A=a_vid_data['timestamp'],
                    sim_A=a_vid_data['temporal_score'],
                    ts_B=best_prev_hit['timestamp'],
                    sim_B=best_prev_hit['temporal_score']
                )
                new_a_temporal_scores[mask_a] = (a_vid_data['temporal_score'] + a_to_best_b_scores + best_link_score) / 3.0

        # --- 3. Final Assembly (Unchanged) ---
        for i, original_result in enumerate(original_A_results):
            original_result['temporal_score'] = new_a_temporal_scores[i]

        new_A_results = [r for r in original_A_results if r['temporal_score'] >= temporal_threshold]
        new_A_results.sort(key=lambda x: x["temporal_score"], reverse=True)
        removed_count = len(original_A_results) - len(new_A_results)

        return new_A_results, removed_count

    def _calculate_chained_temporal_score_for_a(self, a_result, prev_hits, current_hits, is_first_rerank):
        if is_first_rerank: # A -> B
            best_a_to_b_score = 0
            for b_hit in current_hits:
                score = self.compute_temporal_score(keyframeA={"timestamp": a_result["metadata"]["timestamp"], "sim_score": a_result["original_score"]}, keyframeB={"timestamp": b_hit["metadata"]["timestamp"], "sim_score": b_hit["original_score"]})
                if score is not None and score > best_a_to_b_score: best_a_to_b_score = score
            return (a_result["temporal_score"] + best_a_to_b_score) / 2.0
        else: # B -> C, C -> D, etc.
            best_link_score, best_prev_hit = 0, None
            for prev_hit in prev_hits:
                for current_hit in current_hits:
                    score = self.compute_temporal_score(keyframeA={"timestamp": prev_hit["metadata"]["timestamp"], "sim_score": prev_hit["temporal_score"]}, keyframeB={"timestamp": current_hit["metadata"]["timestamp"], "sim_score": current_hit["temporal_score"]})
                    if score is not None and score > best_link_score:
                        best_link_score, best_prev_hit = score, prev_hit
            if best_prev_hit is None: return a_result["temporal_score"] * 0.1
            a_to_best_b_score = self.compute_temporal_score(keyframeA={"timestamp": a_result["metadata"]["timestamp"], "sim_score": a_result["temporal_score"]}, keyframeB={"timestamp": best_prev_hit["metadata"]["timestamp"], "sim_score": best_prev_hit["temporal_score"]})
            if a_to_best_b_score is None: return 0
            return (a_result["temporal_score"] + a_to_best_b_score + best_link_score) / 3.0

    def _group_by_video(self, results):
        grouped = {}
        for r in results:
            vid = r["metadata"]["video_name"]
            grouped.setdefault(vid, []).append(r)
        return grouped

    def _get_hnsw_search_param(self, top_k):
        return {"ef": max(top_k, 32)}
        
    def __del__(self):
        try:
            for collection in self.collections.values(): collection.release()
            if hasattr(self, 'tag_collection'): self.tag_collection.release()
            connections.disconnect("default")
        except Exception as e:
            print(f"Error during cleanup: {e}")
            
if __name__ == '__main__':
    # Example: Initialize with two different models
    # Ensure you have enough VRAM if loading multiple large models on one GPU
    
    models_to_use = [
        # "google/siglip2-base-patch16-512",
        "google/siglip2-large-patch16-512",
        # "google/siglip2-so400m-patch16-384",
        "google/siglip2-giant-opt-patch16-384",
        "google/siglip2-so400m-patch16-512",
        # "google/siglip2-so400m-patch16-naflex"
    ]
    
    manager = MilvusManager(host = "milvus-standalone",
                            port = "19530", 
                            model_paths=models_to_use,
                            num_build_workers=16,
                            )

    # === EXAMPLE: BUILDING AN INDEX (must be done for each model) ===
    # print("\n--- Building index for SigLIP model ---")
    # manager.reset_collection("google/siglip2-so400m-patch16-naflex")
    # manager.build(data_root='/workspace/WorkingSpace/Personal/chinhnm/final', 
    #               metadata_path='/workspace/WorkingSpace/Personal/chinhnm/final/merged_metadata_1.json',
    #               model_name="google/siglip2-so400m-patch16-naflex",
    #               mode='AIC', image_batch_size=32,
    #               insert_batch_size=256)
    # manager.reset_tag_collection()
    # manager.build_tag(processing_batch_size=64, insert_batch_size=1024, tag_file_path='/workspace/WorkingSpace/Personal/chinhnm/LunchBox/tag.txt')
    # print("\n--- Building index for Jina-CLIP model ---")
    # manager.build(data_root='/workspace/data/L01_V001', 
    #               model_name="jinaai/jina-clip-v2",
    #               mode='AIC_concurrent', image_batch_size=64)

    # === EXAMPLE: TEMPORAL SEARCH USING MULTI-MODEL AGGREGATION ===
    # print("\n\n--- TESTING MULTI-MODEL TEMPORAL SEARCH ---")
    start = time.time()
    
    query_A = 'A man walking on a road'
    ocr = "com tam binh dan"
    # Use the new, explicit method to start the chain
    results_A = manager.search(mode='text', query=query_A, search_in='image', 
                               top_k=4000, start_temporal_chain=True, 
                               use_tag=False, top_k_tags=5, database_mode='AIC')
    
    print('\nOriginal top 5 for Query A (using median scores from all models):')
    # if results_A:
    #     for result in results_A:
    #         print(f"  Frame: {result['metadata']['frame_name']}, Video: {result['metadata']['video_name']}, Median Score: {result['score']:.4f}")
    end = time.time()
    print(f"Elapsed time for Query A: {end - start:.2f} seconds")

    # --- Query B ---
    print("\n--- Searching for Query B ---")
    start = time.time()
    tags = ["man", "person", "eat"]
    ocr = "com tam binh dan"
    query_B = 'A man eating'
    temporal_answer = manager.temporal_search_sequence(query_B, mode='text', search_in='image', top_k=1000, 
                                                       use_tag=False, top_k_tags=5, tags_filter=tags, ocr=None)
    end = time.time()
    
    # print(f'Top 10 for Query B (with median scores):')
    # for result in temporal_answer["current_query_results"]:
    #     print(f"  Frame: {result['metadata']['frame_name']}, Median Score: {result['original_score']:.4f}")
        
    # print('\nTop 5 for Query A (reranked after Query B):')
    # for result in temporal_answer["query_A_reranked"][:5]:
    #     print(f"  Frame: {result['metadata']['frame_name']}, New Temporal Score: {result['temporal_score']:.4f}")
    # print(f"Elapsed time for Query B + Reranking: {end - start:.2f} seconds")
    # print("\n--- Searching for Query C ---")
    # start = time.time()
    # query_C = 'A flooded road'
    # temporal_answer = manager.temporal_search_sequence(query_C, mode='text', search_in='image', top_k=10)
    # end = time.time()
    
    # print(f'Top 10 for Query C (with median scores):')
    # for result in temporal_answer["current_query_results"]:
    #     print(f"  Frame: {result['metadata']['frame_name']}, Median Score: {result['original_score']:.4f}")
        
    # print('\nTop 5 for Query A (reranked after Query C):')
    # for result in temporal_answer["query_A_reranked"][:5]:
    #     print(f"  Frame: {result['metadata']['frame_name']}, New Temporal Score: {result['temporal_score']:.4f}")
    # print(f"Elapsed time for Query C + Reranking: {end - start:.2f} seconds")
