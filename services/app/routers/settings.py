from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, Literal

from services.core.config import settings, Settings
from services.core.context import get_indexer

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    vision_max_pixels: Optional[int] = None
    video_max_pixels: Optional[int] = None
    embed_batch_size: Optional[int] = None
    embed_batch_delay_ms: Optional[int] = None
    vision_batch_delay_ms: Optional[int] = None
    search_result_limit: Optional[int] = None
    qa_context_limit: Optional[int] = None
    max_snippet_length: Optional[int] = None
    summary_max_tokens: Optional[int] = None
    pdf_one_chunk_per_page: Optional[bool] = None
    rag_chunk_size: Optional[int] = None
    rag_chunk_overlap: Optional[int] = None
    default_indexing_mode: Optional[Literal["fast", "deep"]] = None


@router.get("/")
async def get_settings():
    return {
        "vision_max_pixels": settings.vision_max_pixels,
        "video_max_pixels": settings.video_max_pixels,
        "embed_batch_size": settings.embed_batch_size,
        "embed_batch_delay_ms": settings.embed_batch_delay_ms,
        "vision_batch_delay_ms": settings.vision_batch_delay_ms,
        "search_result_limit": settings.search_result_limit,
        "qa_context_limit": settings.qa_context_limit,
        "max_snippet_length": settings.max_snippet_length,
        "summary_max_tokens": settings.summary_max_tokens,
        "pdf_one_chunk_per_page": settings.pdf_one_chunk_per_page,
        "rag_chunk_size": settings.rag_chunk_size,
        "rag_chunk_overlap": settings.rag_chunk_overlap,
        "default_indexing_mode": settings.default_indexing_mode,
    }


@router.patch("/")
async def update_settings(update: SettingsUpdate):
    if update.vision_max_pixels is not None:
        settings.vision_max_pixels = update.vision_max_pixels
    if update.video_max_pixels is not None:
        settings.video_max_pixels = update.video_max_pixels
    if update.embed_batch_size is not None:
        settings.embed_batch_size = update.embed_batch_size
    if update.embed_batch_delay_ms is not None:
        settings.embed_batch_delay_ms = update.embed_batch_delay_ms
    if update.vision_batch_delay_ms is not None:
        settings.vision_batch_delay_ms = update.vision_batch_delay_ms
    if update.search_result_limit is not None:
        settings.search_result_limit = update.search_result_limit
    if update.qa_context_limit is not None:
        settings.qa_context_limit = update.qa_context_limit
    if update.max_snippet_length is not None:
        settings.max_snippet_length = update.max_snippet_length
    if update.summary_max_tokens is not None:
        settings.summary_max_tokens = update.summary_max_tokens
    if update.pdf_one_chunk_per_page is not None:
        settings.pdf_one_chunk_per_page = update.pdf_one_chunk_per_page
    if update.rag_chunk_size is not None:
        settings.rag_chunk_size = update.rag_chunk_size
    if update.rag_chunk_overlap is not None:
        settings.rag_chunk_overlap = update.rag_chunk_overlap
    if update.default_indexing_mode is not None:
        settings.default_indexing_mode = update.default_indexing_mode

    settings.save_to_file()

    return {
        "status": "ok",
        "settings": {
            "vision_max_pixels": settings.vision_max_pixels,
            "video_max_pixels": settings.video_max_pixels,
            "embed_batch_size": settings.embed_batch_size,
            "embed_batch_delay_ms": settings.embed_batch_delay_ms,
            "vision_batch_delay_ms": settings.vision_batch_delay_ms,
            "search_result_limit": settings.search_result_limit,
            "qa_context_limit": settings.qa_context_limit,
            "max_snippet_length": settings.max_snippet_length,
            "summary_max_tokens": settings.summary_max_tokens,
            "pdf_one_chunk_per_page": settings.pdf_one_chunk_per_page,
            "rag_chunk_size": settings.rag_chunk_size,
            "rag_chunk_overlap": settings.rag_chunk_overlap,
            "default_indexing_mode": settings.default_indexing_mode,
        }
    }
