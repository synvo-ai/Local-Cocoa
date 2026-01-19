from __future__ import annotations

import asyncio
import datetime as dt
import logging
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status

from services.core.context import get_indexer, get_storage
from services.core.models import (
    IndexRequest,
    IndexingItem,
    IndexInventory,
    IndexProgress,
    IndexSummary,
)
from services.indexer import Indexer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/index", tags=["index"])


@router.get("/status", response_model=IndexProgress)
def get_status() -> IndexProgress:
    return get_indexer().status()


@router.post("/run", response_model=IndexProgress)
async def run_index(payload: IndexRequest) -> IndexProgress:
    indexer = get_indexer()

    folders = payload.folders or []
    scope = payload.scope or ("folder" if folders else "global")
    if scope == "global" and folders:
        scope = "folder"

    if scope != "global" and not folders:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="folders are required for non-global rescan/reindex requests.",
        )

    mode = payload.mode or "rescan"
    purge_targets = list(payload.purge_folders or [])

    # Backwards compatibility: legacy flags imply a reindex.
    if payload.drop_collection:
        mode = "reindex"
        scope = "global"
    elif purge_targets and mode == "rescan":
        mode = "reindex"
        if scope == "global" and folders:
            scope = "folder"
    elif payload.refresh_embeddings and mode == "rescan" and not folders:
        mode = "reindex"

    effective_drop_collection = payload.drop_collection
    effective_refresh_embeddings = payload.refresh_embeddings

    if mode == "reindex":
        effective_refresh_embeddings = True
        if scope == "global":
            effective_drop_collection = True
            purge_targets = []
        else:
            effective_drop_collection = False
            purge_targets = folders if folders else purge_targets
    else:
        effective_drop_collection = False
        if scope != "global":
            purge_targets = []

    if effective_drop_collection and folders:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="drop_collection cannot be combined with targeted folders.",
        )

    effective_indexing_mode = payload.get_indexing_mode()

    async def task() -> None:
        logger.info(
            "Index job starting: mode=%s scope=%s indexing_mode=%s folders=%d files=%d drop_collection=%s refresh_embeddings=%s purge_folders=%d",
            mode,
            scope,
            effective_indexing_mode,
            len(folders or []),
            len(payload.files or []),
            bool(effective_drop_collection),
            bool(effective_refresh_embeddings),
            len(purge_targets or []),
        )
        try:
            await indexer.refresh(
                folders=folders if scope != "global" else None,
                files=payload.files,
                refresh_embeddings=effective_refresh_embeddings,
                drop_collection=effective_drop_collection,
                purge_folders=purge_targets,
                indexing_mode=effective_indexing_mode,
            )
        except Exception:  # noqa: BLE001
            logger.exception("Index job crashed")
            raise
        finally:
            status_snapshot = indexer.status()
            logger.info(
                "Index job finished: status=%s processed=%d failed=%d message=%s",
                status_snapshot.status,
                status_snapshot.processed,
                status_snapshot.failed,
                status_snapshot.message,
            )

    if indexer.status().status == "running":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Index job already running.")

    logger.info(
        "Index run requested: mode=%s scope=%s indexing_mode=%s folders=%d files=%d",
        mode,
        scope,
        effective_indexing_mode,
        len(folders or []),
        len(payload.files or []),
    )

    # Avoid a UX race where the response returns `idle` because the background task
    # hasn't acquired the indexer's lock yet (fast scans can finish before polling sees `running`).
    now = dt.datetime.now(dt.timezone.utc)
    indexer.progress = IndexProgress(
        status="running",
        started_at=now,
        completed_at=None,
        processed=0,
        failed=0,
        total=None,
        message="Starting indexing…",
    )

    asyncio.create_task(task())
    await asyncio.sleep(0.1)

    return indexer.status()


@router.post("/reindex", response_model=IndexProgress)
async def hard_reindex() -> IndexProgress:
    indexer = get_indexer()

    async def task() -> None:
        await indexer.refresh(refresh_embeddings=True, drop_collection=True)

    if indexer.status().status == "running":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Index job already running.")

    asyncio.create_task(task())
    await asyncio.sleep(0.1)

    return indexer.status()


@router.post("/pause", response_model=IndexProgress)
def pause_index() -> IndexProgress:
    indexer = get_indexer()
    if indexer.status().status != "running":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Indexer is not running.")
    return indexer.pause()


@router.post("/resume", response_model=IndexProgress)
def resume_index() -> IndexProgress:
    indexer = get_indexer()
    if indexer.status().status != "paused":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Indexer is not paused.")
    return indexer.resume()


@router.get("/summary", response_model=IndexSummary)
async def get_summary() -> IndexSummary:
    storage = get_storage()
    loop = asyncio.get_running_loop()

    def _get_summary_data():
        files, folders = storage.counts()
        all_folders = storage.list_folders()
        last_completed = max(
            (folder.last_indexed_at for folder in all_folders if folder.last_indexed_at),
            default=None,
        )
        total_size = storage.total_size()
        return files, folders, last_completed, total_size

    files, folders, last_completed, total_size = await loop.run_in_executor(None, _get_summary_data)

    return IndexSummary(
        files_indexed=files,
        total_size_bytes=total_size,
        folders_indexed=folders,
        last_completed_at=last_completed,
    )


@router.get("/list", response_model=IndexInventory)
async def list_index_inventory(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        folder_id: str | None = None,
) -> IndexInventory:
    storage = get_storage()
    loop = asyncio.get_running_loop()

    files, total = await loop.run_in_executor(None, lambda: storage.list_files(limit=limit, offset=offset, folder_id=folder_id))

    indexer = get_indexer()
    indexing_items = indexer.indexing_items(folder_id=folder_id)
    return IndexInventory(files=files, total=total, indexing=indexing_items, progress=indexer.status())


# ═══════════════════════════════════════════════════════════════════════════════
# Two-Round Staged Indexing API
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/stage-progress")
async def get_stage_progress(folder_id: str | None = None) -> dict:
    """Get progress statistics for all indexing stages.

    Returns:
        Dict with counts and percentages for each stage:
        - fast_text: {pending, done, error, percent}
        - fast_embed: {pending, done, error, percent}
        - deep: {pending, done, skipped, error, percent}
        - paused: {fast_text, fast_embed, deep}
    """
    indexer = get_indexer()
    return indexer.stage_progress(folder_id)


@router.post("/pause/{stage}")
def pause_stage(stage: str) -> dict:
    """Pause a specific indexing stage.

    Args:
        stage: One of 'fast_text', 'fast_embed', 'deep'
    """
    if stage not in ("fast_text", "fast_embed", "deep"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid stage: {stage}. Must be one of: fast_text, fast_embed, deep"
        )

    indexer = get_indexer()
    success = indexer.pause_stage(stage)
    return {"stage": stage, "paused": success}


@router.post("/resume/{stage}")
def resume_stage(stage: str) -> dict:
    """Resume a specific indexing stage.

    Args:
        stage: One of 'fast_text', 'fast_embed', 'deep'
    """
    if stage not in ("fast_text", "fast_embed", "deep"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid stage: {stage}. Must be one of: fast_text, fast_embed, deep"
        )

    indexer = get_indexer()
    success = indexer.resume_stage(stage)
    return {"stage": stage, "resumed": success}


@router.post("/run-staged", response_model=IndexProgress)
async def run_staged_index(payload: IndexRequest) -> IndexProgress:
    """Run two-round staged indexing. (Optimized start)

    This uses priority-based scheduling:
    1. All files -> Fast Text (keyword search ready)
    2. All files -> Fast Embedding (vector search ready)  
    3. Files one-by-one -> Deep (enhanced search)
    """
    indexer = get_indexer()

    folders = payload.folders or []
    is_reindex = payload.mode == "reindex"

    async def task() -> None:
        logger.info(
            "Staged index job starting: folders=%d files=%d reindex=%s",
            len(folders or []),
            len(payload.files or []),
            is_reindex,
        )
        try:
            await indexer.refresh_staged(
                folders=folders if folders else None,
                files=payload.files,
                reindex=is_reindex,
            )
        except Exception:
            logger.exception("Staged index job crashed")
            raise
        finally:
            status_snapshot = indexer.status()
            logger.info(
                "Staged index job finished: status=%s processed=%d failed=%d",
                status_snapshot.status,
                status_snapshot.processed,
                status_snapshot.failed,
            )

    if indexer.status().status == "running":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Index job already running.")

    # Set initial status
    now = dt.datetime.now(dt.timezone.utc)
    indexer.progress = IndexProgress(
        status="running",
        started_at=now,
        completed_at=None,
        processed=0,
        failed=0,
        total=None,
        message="Starting staged indexing…",
    )

    asyncio.create_task(task())
    # Yield control to allow the task to perform initial setup (e.g. acquire lock)
    # This prevents a race condition where the UI polls status and sees 'idle'
    # before the task has actually started running.
    await asyncio.sleep(0.1)

    return indexer.status()


# ═══════════════════════════════════════════════════════════════════════════════
# Semantic Indexing Control (Fast Embed)
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/start-semantic")
async def start_semantic_indexing(background: BackgroundTasks) -> dict:
    """Start Semantic indexing (embedding generation).

    Semantic indexing is paused by default.
    User must explicitly call this endpoint to enable embedding processing.

    Note: This enables vector/semantic search capabilities.
    """
    indexer = get_indexer()
    started = indexer.start_semantic()
    
    # If semantic was just enabled and indexer is not currently running,
    # start a background task to process pending embeddings
    if started and indexer.status().status != "running":
        async def run_semantic_task() -> None:
            logger.info("Starting semantic processing task...")
            try:
                await indexer.refresh_staged(skip_pending_registration=True)
            except Exception:
                logger.exception("Semantic processing task failed")
        
        # Set status to running before starting background task
        now = dt.datetime.now(dt.timezone.utc)
        indexer.progress = IndexProgress(
            status="running",
            started_at=now,
            completed_at=None,
            processed=0,
            failed=0,
            total=None,
            message="Processing semantic embeddings…",
        )
        background.add_task(run_semantic_task)
    
    return {
        "semantic_enabled": indexer.is_semantic_enabled(),
        "started": started,
        "message": "Semantic indexing started. This enables vector search." if started else "Semantic indexing is already enabled."
    }


@router.post("/stop-semantic")
def stop_semantic_indexing() -> dict:
    """Stop Semantic indexing (embedding generation).

    Pauses embedding processing.
    Keyword search will still work.
    """
    indexer = get_indexer()
    stopped = indexer.stop_semantic()
    return {
        "semantic_enabled": indexer.is_semantic_enabled(),
        "stopped": stopped,
        "message": "Semantic indexing stopped." if stopped else "Semantic indexing is already paused."
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Deep Indexing Control (Vision)
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/start-deep")
async def start_deep_indexing(background: BackgroundTasks) -> dict:
    """Start Deep indexing (Round 2).

    Deep indexing is paused by default to prevent high CPU usage.
    User must explicitly call this endpoint to enable Deep processing.

    Note: This will cause the system to run at high capacity.
    """
    indexer = get_indexer()
    started = indexer.start_deep()
    
    # If deep was just enabled and indexer is not currently running,
    # start a background task to process pending deep indexing
    if started and indexer.status().status != "running":
        async def run_deep_task() -> None:
            logger.info("Starting deep processing task...")
            try:
                await indexer.refresh_staged(skip_pending_registration=True)
            except Exception:
                logger.exception("Deep processing task failed")
        
        # Set status to running before starting background task
        now = dt.datetime.now(dt.timezone.utc)
        indexer.progress = IndexProgress(
            status="running",
            started_at=now,
            completed_at=None,
            processed=0,
            failed=0,
            total=None,
            message="Processing deep indexing…",
        )
        background.add_task(run_deep_task)
    
    return {
        "deep_enabled": indexer.is_deep_enabled(),
        "started": started,
        "message": "Deep indexing started. Note: This will use significant CPU resources." if started else "Deep indexing is already enabled."
    }


@router.post("/stop-deep")
def stop_deep_indexing() -> dict:
    """Stop Deep indexing (Round 2).

    Pauses Deep processing to reduce CPU usage.
    Fast indexing (Round 1) will continue normally.
    """
    indexer = get_indexer()
    stopped = indexer.stop_deep()
    return {
        "deep_enabled": indexer.is_deep_enabled(),
        "stopped": stopped,
        "message": "Deep indexing stopped." if stopped else "Deep indexing is already paused."
    }


@router.get("/deep-status")
def get_deep_status() -> dict:
    """Get Deep indexing status.

    Returns whether Deep processing is enabled and current progress.
    """
    indexer = get_indexer()
    progress = indexer.stage_progress()

    return {
        "deep_enabled": indexer.is_deep_enabled(),
        "deep_progress": progress.get("deep", {}),
        "message": "Deep indexing is running." if indexer.is_deep_enabled() else "Deep indexing is paused. Call POST /index/start-deep to enable."
    }
