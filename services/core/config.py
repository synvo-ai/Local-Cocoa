from __future__ import annotations

import os
import logging
import logging.handlers
import platform
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field


def _get_default_rag_home() -> Path:
    """
    Get default LOCAL_RAG_HOME path.

    First checks LOCAL_RAG_HOME env var. If not set, uses system-appropriate
    user data directory to ensure writability in packaged apps.
    """
    env_home = os.getenv("LOCAL_RAG_HOME")
    if env_home:
        return Path(env_home)

    # Fallback to system user data directory (writable even in packaged apps)
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        # macOS: ~/Library/Application Support/Local Cocoa/local_rag
        base = home / "Library" / "Application Support" / "Local Cocoa" / "local_rag"
    elif system == "Windows":
        # Windows: %APPDATA%\local-cocoa\local_rag
        appdata = os.getenv("APPDATA", str(home / "AppData" / "Roaming"))
        base = Path(appdata) / "local-cocoa" / "local_rag"
    else:
        # Linux: ~/.config/local-cocoa/local_rag
        base = home / ".config" / "local-cocoa" / "local_rag"

    return base


class ServiceEndpoints(BaseModel):
    llm: str = Field(default_factory=lambda: os.getenv("LOCAL_LLM_URL", "http://127.0.0.1:8007"))
    embedding: str = Field(default_factory=lambda: os.getenv("LOCAL_EMBEDDING_URL", "http://127.0.0.1:8005"))
    rerank: str = Field(default_factory=lambda: os.getenv("LOCAL_RERANK_URL", "http://127.0.0.1:8006"))
    vision: Optional[str] = Field(default_factory=lambda: os.getenv("LOCAL_VISION_URL", "http://127.0.0.1:8007"))
    transcription: Optional[str] = Field(default_factory=lambda: os.getenv("LOCAL_TRANSCRIBE_URL", "http://127.0.0.1:8080"))


def _get_qdrant_path() -> str:
    """
    Get Qdrant storage path.

    - If LOCAL_QDRANT_PATH is explicitly set, use it directly (dev mode uses relative paths)
    - If not set, use base_dir/qdrant_data (packaged app default)
    """
    env_path = os.getenv("LOCAL_QDRANT_PATH")
    if env_path:
        # Explicitly set - use as-is (supports both dev relative and prod absolute paths)
        return env_path

    # Not set - default to user data directory (for packaged apps)
    base = _get_default_rag_home()
    return str(base / "qdrant_data")


class QdrantConfig(BaseModel):
    path: str = Field(default_factory=_get_qdrant_path)
    collection_name: str = Field(default_factory=lambda: os.getenv("LOCAL_QDRANT_COLLECTION", "local_cocoa_files"))
    embedding_dim: int = Field(default_factory=lambda: int(os.getenv("LOCAL_QDRANT_DIM", 1024)))
    metric_type: Literal["COSINE", "DOT", "EUCLID"] = Field(
        default_factory=lambda: os.getenv("LOCAL_QDRANT_METRIC", "COSINE").upper()  # type: ignore[arg-type]
    )


class Settings(BaseModel):
    base_dir: Path = Field(default_factory=_get_default_rag_home)
    poll_interval_seconds: int = Field(default_factory=lambda: int(os.getenv("LOCAL_RAG_POLL_SECONDS", 90)))
    refresh_on_startup: bool = Field(default_factory=lambda: os.getenv(
        "LOCAL_RAG_REFRESH_ON_STARTUP", "true").lower() == "true")
    endpoints: ServiceEndpoints = Field(default_factory=ServiceEndpoints)
    db_filename: str = Field(default_factory=lambda: os.getenv("LOCAL_RAG_DB_NAME", "index.sqlite"))
    max_depth: int = Field(default_factory=lambda: int(os.getenv("LOCAL_RAG_MAX_DEPTH", 12)))
    follow_symlinks: bool = Field(default_factory=lambda: os.getenv(
        "LOCAL_RAG_FOLLOW_SYMLINKS", "false").lower() == "true")
    reuse_embeddings: bool = Field(default_factory=lambda: os.getenv(
        "LOCAL_RAG_REUSE_EMBEDDINGS", "true").lower() == "true")
    embed_batch_size: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_RAG_EMBED_BATCH", 32)), 1))
    # Delay for lightweight text embedding operations (default: 0ms)
    embed_batch_delay_ms: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_RAG_EMBED_DELAY_MS", 0)), 0))
    # Delay for heavy vision/LLM operations to prevent GPU saturation (default: 200ms)
    vision_batch_delay_ms: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_RAG_VISION_DELAY_MS", 200)), 0))
    embed_max_chars: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_RAG_EMBED_MAX_CHARS", 1600)), 256))
    supported_modes: tuple[Literal["search", "qa"], ...] = ("search", "qa")
    snapshot_interval_seconds: int = Field(default_factory=lambda: int(os.getenv("LOCAL_RAG_SNAPSHOT_SECONDS", 600)))
    llm_context_tokens: int = Field(default_factory=lambda: max(
        int(os.getenv("LOCAL_LLM_CONTEXT_TOKENS", 32768)), 2048))
    llm_max_prompt_tokens: int = Field(default_factory=lambda: max(
        int(os.getenv("LOCAL_LLM_MAX_PROMPT_TOKENS", 32768)), 1024))
    llm_chars_per_token: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_LLM_CHARS_PER_TOKEN", 8)), 1))

    # Vision settings
    # Default to ~1MP (1280*28*28 approx 1M pixels, or 1003520)
    # Low spec mode can set this to ~200k (256*28*28 approx 200k pixels)
    vision_max_pixels: int = Field(default_factory=lambda: int(os.getenv("LOCAL_VISION_MAX_PIXELS", 1003520)))

    # Video frame resolution (separate from image resolution)
    # Default to ~480p (640×480 = 307,200 pixels) - lower than images since we process multiple frames
    # and video understanding doesn't require as high resolution as image analysis
    video_max_pixels: int = Field(default_factory=lambda: int(os.getenv("LOCAL_VIDEO_MAX_PIXELS", 307200)))

    # Search settings
    search_result_limit: int = Field(default_factory=lambda: int(os.getenv("LOCAL_SEARCH_LIMIT", 15)))
    qa_context_limit: int = Field(default_factory=lambda: int(os.getenv("LOCAL_QA_CONTEXT_LIMIT", 5)))
    max_snippet_length: int = Field(default_factory=lambda: int(os.getenv("LOCAL_MAX_SNIPPET_LENGTH", 2000)))

    # Indexing summary settings
    # Controls the max output tokens used when generating file summaries during indexing.
    summary_max_tokens: int = Field(default_factory=lambda: max(int(os.getenv("LOCAL_SUMMARY_MAX_TOKENS", 100)), 32))
    # Controls the max input characters from the document to be used for summarization
    summary_input_max_chars: int = Field(default_factory=lambda: int(
        os.getenv("LOCAL_SUMMARY_INPUT_MAX_CHARS", 100000)))

    # PDF page VLM extraction settings
    # Controls the max output tokens when VLM processes a single PDF page.
    # Default: min(2048, context_size // 4) to leave room for image tokens and prompts.
    # Set higher (3072-4096) for complex pages with many tables/charts.
    pdf_page_max_tokens: int = Field(default_factory=lambda: max(
        min(
            int(os.getenv("LOCAL_PDF_PAGE_MAX_TOKENS", 2048)),
            int(os.getenv("LOCAL_LLM_CONTEXT_TOKENS", 32768)) // 4  # Reserve 75% for input
        ),
        256
    ))

    qdrant: QdrantConfig = Field(default_factory=QdrantConfig)
    # PDF processing mode: "text" (OCR text extraction) or "vision" (default, VLM per-page analysis)
    pdf_mode: Literal["text", "vision"] = Field(
        default_factory=lambda: os.getenv("LOCAL_PDF_MODE", "text").lower()  # type: ignore[arg-type]
    )

    # PDF chunking mode:
    # - True: one chunk per page (faster indexing, simpler UI)
    # - False: allow multiple chunks (better retrieval granularity)
    pdf_one_chunk_per_page: bool = Field(
        default_factory=lambda: os.getenv("LOCAL_PDF_ONE_CHUNK_PER_PAGE", "false").lower() == "true"
    )

    # Custom chunking settings (overrides defaults if set)
    rag_chunk_size: int = Field(default_factory=lambda: int(os.getenv("LOCAL_RAG_CHUNK_SIZE", 200)))
    rag_chunk_overlap: int = Field(default_factory=lambda: int(os.getenv("LOCAL_RAG_CHUNK_OVERLAP", 40)))

    # Default indexing mode for new files:
    # - "fast": Quick text-based indexing, good for most documents
    # - "deep": Deep vision-based analysis, better for images, complex PDFs
    default_indexing_mode: Literal["fast", "deep"] = Field(
        default_factory=lambda: os.getenv("LOCAL_DEFAULT_INDEXING_MODE", "deep").lower()  # type: ignore[arg-type]
    )

    # Memory extraction: extract episodes, foresights, event logs from files
    enable_memory_extraction: bool = Field(
        default_factory=lambda: os.getenv("LOCAL_ENABLE_MEMORY_EXTRACTION", "true").lower() == "true"
    )
    memory_user_id: str = Field(
        default_factory=lambda: os.getenv("LOCAL_MEMORY_USER_ID", "default_user")
    )

    class Config:
        frozen = False

    @property
    def db_path(self) -> Path:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        return self.base_dir / self.db_filename

    @property
    def settings_path(self) -> Path:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        return self.base_dir / "rag_settings.json"

    def save_to_file(self):
        import json
        data = {
            "vision_max_pixels": self.vision_max_pixels,
            "video_max_pixels": self.video_max_pixels,
            "embed_batch_size": self.embed_batch_size,
            "embed_batch_delay_ms": self.embed_batch_delay_ms,
            "vision_batch_delay_ms": self.vision_batch_delay_ms,
            "search_result_limit": self.search_result_limit,
            "qa_context_limit": self.qa_context_limit,
            "max_snippet_length": self.max_snippet_length,
            "summary_max_tokens": self.summary_max_tokens,
            "pdf_one_chunk_per_page": self.pdf_one_chunk_per_page,
            "rag_chunk_size": self.rag_chunk_size,
            "rag_chunk_overlap": self.rag_chunk_overlap,
            "default_indexing_mode": self.default_indexing_mode,
        }
        try:
            with open(self.settings_path, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logging.getLogger(__name__).error(f"Failed to save settings: {e}")

    def load_from_file(self):
        import json
        if not self.settings_path.exists():
            return
        try:
            with open(self.settings_path, 'r') as f:
                data = json.load(f)
                for key, value in data.items():
                    if hasattr(self, key):
                        setattr(self, key, value)
        except Exception as e:
            logging.getLogger(__name__).error(f"Failed to load settings: {e}")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    s.load_from_file()
    return s


settings = get_settings()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "WARN").upper(),
    format='[local_agent]%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
    ]
)

if (os.getenv("LOCAL_AGENT_LOG_PATH")):
    log_path = os.getenv("LOCAL_AGENT_LOG_PATH")
    if log_path:
        log_dir = os.path.dirname(log_path)
        if log_dir:
            try:
                os.makedirs(log_dir, exist_ok=True)
                file_handler = logging.handlers.RotatingFileHandler(
                    log_path,
                    maxBytes=10 * 1024 * 1024,
                    backupCount=3,
                    encoding="utf-8"
                )
                file_handler.setFormatter(logging.Formatter(
                    '[local_agent]%(asctime)s - %(name)s - %(levelname)s - %(message)s'
                ))
                logging.getLogger().addHandler(file_handler)
            except OSError as e:
                logging.getLogger(__name__).warning(f"Could not create log directory {log_dir}: {e}. File logging disabled.")