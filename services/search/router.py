from __future__ import annotations
import random
import re
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from services.core.context import get_search_engine, get_storage
from services.core.models import (
    QaRequest,
    QaResponse,
    SearchResponse,
    SearchHit,
    SubQueryResult,
)
import logging
logger = logging.getLogger(__name__)

router = APIRouter(tags=["search"])


def _clean_question_prefix(q: str) -> str:
    """Remove leading numbering like '1. ', '2) ', '- ', etc. from a question."""
    q = q.strip().lstrip("- ").strip()
    q = re.sub(r'^[\d]+[.\)]\s*', '', q).strip()
    return q


@router.get("/suggestions", response_model=list[str])
async def get_suggestions(limit: int = Query(default=4, ge=1, le=10)):
    """Get suggested questions by randomly sampling from the question pool."""
    storage = get_storage()
    # Fetch more files to build a larger question pool
    files = storage.get_recent_files_with_suggestions(limit=20)

    all_questions = []
    for f in files:
        qs = f.metadata.get("suggested_questions")
        if qs and isinstance(qs, list):
            all_questions.extend(qs)

    # Clean up any leading numbering and deduplicate
    cleaned_questions = [_clean_question_prefix(q) for q in all_questions if q]
    unique_questions = list(dict.fromkeys(cleaned_questions))

    # Randomly sample from the pool
    if len(unique_questions) <= limit:
        return unique_questions
    return random.sample(unique_questions, limit)


@router.get("/search", response_model=SearchResponse)
async def search(
    query: str = Query(alias="q"),
    limit: int = Query(default=5, ge=1, le=20),
    multi_path: bool = Query(default=True, description="Enable multi-path retrieval for complex queries"),
) -> SearchResponse:
    engine = get_search_engine()
    logger.info(f"GET /search: q={query}")
    if not query.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Query cannot be empty.")
    try:
        return await engine.search(query.strip(), limit=limit, enable_multi_path=multi_path)
    except EmbeddingUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Embedding service unavailable. Restart the local embedding server and try again.") from exc


@router.get("/resume", response_model=SearchResponse)
async def search_resume(
    query: str = Query(alias="q"),
    token: str = Query(..., description="Resume token"),
    limit: int = Query(default=5, ge=1, le=20),
) -> SearchResponse:
    """Resume a progressive search from a pause point."""
    engine = get_search_engine()
    logger.info(f"GET /search/resume: q={query} token={token}")
    if not query.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Query cannot be empty.")
    try:
        # Resume progressive search
        return await engine.multi_path_search(query.strip(), limit=limit, resume_token=token)
    except Exception as exc:
        logger.error(f"Resume failed: {exc}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))


@router.get("/search/stream")
async def search_stream(
    query: str = Query(alias="q"),
    limit: int = Query(default=10, ge=1, le=20),
):
    """
    Progressive/layered search with streaming results.

    Returns Server-Sent Events (SSE) with incremental results from:
    1. Filename matching (fastest)
    2. Summary search
    3. Metadata search
    4. Hybrid vector search (slowest but most semantic)

    Each event contains: {stage, hits, totalHits, done, latencyMs}
    """
    engine = get_search_engine()
    logger.info(f"GET /search/stream: q={query}")
    if not query.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Query cannot be empty.")

    return StreamingResponse(
        engine.stream_search(query.strip(), limit=limit),
        media_type="application/x-ndjson"
    )


@router.post("/qa", response_model=QaResponse)
async def qa(payload: QaRequest) -> QaResponse:
    logger.info(f"POST /qa: q={payload.query}")
    engine = get_search_engine()
    return await engine.answer(payload)


@router.post("/qa/stream")
async def qa_stream(payload: QaRequest):
    logger.info(f"POST /qa/stream: q={payload.query}")
    engine = get_search_engine()
    return StreamingResponse(engine.stream_answer(payload), media_type="application/x-ndjson")
