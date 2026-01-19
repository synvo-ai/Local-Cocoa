"""
Memory Router - FastAPI endpoints for memory management
"""

from fastapi import APIRouter, HTTPException, status, Query
from typing import List, Optional

from services.memory.models import (
    MemorizeRequest,
    MemorizeResult,
    SearchMemoryRequest,
    SearchMemoryResult,
    UserMemorySummary,
    EpisodeRecord,
    EventLogRecord,
    ForesightRecord,
    MemoryTypeEnum,
    RetrieveMethodEnum,
)
from services.memory.service import get_memory_service, MemoryServiceError, MemoryNotFound

router = APIRouter(prefix="/memory", tags=["memory"])


@router.post("/memorize", response_model=MemorizeResult)
async def memorize(request: MemorizeRequest) -> MemorizeResult:
    """
    Process raw data and extract memories

    This endpoint processes conversation or other raw data to extract:
    - Episodic memories (summaries of events)
    - Event logs (atomic facts)
    - Foresights (prospective associations)
    - Profile updates
    """
    try:
        service = get_memory_service()
        return await service.memorize(request)
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal error: {str(e)}",
        ) from e


@router.post("/search", response_model=SearchMemoryResult)
async def search_memories(request: SearchMemoryRequest) -> SearchMemoryResult:
    """
    Search user memories

    Supports multiple retrieval methods:
    - keyword: BM25 keyword search
    - vector: Embedding-based semantic search
    - hybrid: Combined keyword + vector
    - rrf: Reciprocal Rank Fusion
    - agentic: LLM-guided multi-round retrieval
    """
    try:
        service = get_memory_service()
        return await service.search(request)
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.get("/{user_id}", response_model=UserMemorySummary)
async def get_user_memory_summary(user_id: str) -> UserMemorySummary:
    """
    Get summary of user's memories

    Returns profile information and memory counts.
    """
    try:
        service = get_memory_service()
        return await service.get_user_summary(user_id)
    except MemoryNotFound as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        ) from e
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.get("/{user_id}/episodes", response_model=List[EpisodeRecord])
async def get_user_episodes(
    user_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> List[EpisodeRecord]:
    """
    Get user's episodic memories

    Episodic memories are narrative summaries of events and experiences.
    """
    try:
        service = get_memory_service()
        return await service.get_episodes(user_id, limit, offset)
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.get("/{user_id}/events", response_model=List[EventLogRecord])
async def get_user_event_logs(
    user_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> List[EventLogRecord]:
    """
    Get user's event logs (atomic facts)

    Event logs are fine-grained atomic facts extracted from episodic memories.
    """
    try:
        service = get_memory_service()
        return await service.get_event_logs(user_id, limit, offset)
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


@router.get("/{user_id}/foresights", response_model=List[ForesightRecord])
async def get_user_foresights(
    user_id: str,
    limit: int = Query(default=50, ge=1, le=200),
) -> List[ForesightRecord]:
    """
    Get user's foresights (prospective memories)

    Foresights are predictions and prospective associations extracted from memories.
    """
    try:
        service = get_memory_service()
        return await service.get_foresights(user_id, limit)
    except MemoryServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
