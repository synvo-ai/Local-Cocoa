"""Orchestrator for the indexing pipeline."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from pathlib import Path
from typing import Literal, Optional

from services.chunker import ChunkingPipeline, chunking_pipeline
from services.llm.client import EmbeddingClient, LlmClient, TranscriptionClient
from services.core.config import settings
from services.core.content import ContentRouter, content_router
from services.core.models import (
    ChunkSnapshot,
    FileRecord,
    FolderRecord,
    ActivityLog,
)
from services.core.models import IndexProgress, IndexingItem
from services.storage import IndexStorage
from services.core.vector_store import VectorStore, get_vector_store
from services.vlm import VisionProcessor
from .processor import FileProcessor
from .scanner import Scanner
from .state import StateManager
from .scheduler import TwoRoundScheduler
from .stages import FastTextProcessor, FastEmbedProcessor, DeepProcessor

logger = logging.getLogger(__name__)


class Indexer:
    """Coordinates folder scans, parsing, summarisation, and vector persistence."""

    def __init__(
        self,
        storage: IndexStorage,
        *,
        embedding_client: EmbeddingClient,
        llm_client: LlmClient,
        transcription_client: Optional[TranscriptionClient] = None,
        content: ContentRouter = content_router,
        chunker: ChunkingPipeline = chunking_pipeline,
        vectors: Optional[VectorStore] = None,
        vision_processor: Optional[VisionProcessor] = None,
    ) -> None:
        self.storage = storage
        self.vector_store = vectors or get_vector_store()
        self.embedding_client = embedding_client
        self.llm_client = llm_client

        # Subsystems
        self.state = StateManager(storage)
        self.scanner = Scanner(storage)

        # Legacy processor (for backwards compatibility)
        self.processor = FileProcessor(
            storage=storage,
            state_manager=self.state,
            embedding_client=embedding_client,
            llm_client=llm_client,
            transcription_client=transcription_client,
            content=content,
            chunker=chunker,
            vectors=vectors,
            vision_processor=vision_processor,
            enable_memory_extraction=settings.enable_memory_extraction,
            memory_user_id=settings.memory_user_id,
        )

        # Two-round stage processors
        self._fast_text = FastTextProcessor(
            storage=storage,
            state_manager=self.state,
            content=content,
            chunker=chunker,
            enable_memory_extraction=settings.enable_memory_extraction,
            memory_user_id=settings.memory_user_id,
        )
        self._fast_embed = FastEmbedProcessor(
            storage=storage,
            state_manager=self.state,
            embedding_client=embedding_client,
            vectors=vectors,
        )
        self._deep = DeepProcessor(
            storage=storage,
            state_manager=self.state,
            embedding_client=embedding_client,
            llm_client=llm_client,
            chunker=chunker,
            vectors=vectors,
            vision_processor=vision_processor,
        )

        # Two-round scheduler
        self.scheduler = TwoRoundScheduler(
            storage=storage,
            state_manager=self.state,
            fast_text_processor=self._fast_text,
            fast_embed_processor=self._fast_embed,
            deep_processor=self._deep,
        )
        
        # Event signaled when new files are registered and need processing
        self._pending_files_event: asyncio.Event | None = None

    # --- Public API / State Delegation ---
    
    def get_pending_files_event(self) -> asyncio.Event:
        """Get or create the event that signals pending files need processing."""
        if self._pending_files_event is None:
            self._pending_files_event = asyncio.Event()
        return self._pending_files_event
    
    def signal_pending_files(self) -> None:
        """Signal that there are pending files that need processing."""
        if self._pending_files_event is not None:
            self._pending_files_event.set()
            
    async def trigger_staged_if_pending(self) -> bool:
        """Check for pending files and trigger staged indexing if needed.
        
        Returns:
            True if staged indexing was triggered, False otherwise.
        """
        # Check if there are any pending files (fast_stage=0)
        pending = self.storage.list_files_by_stage(fast_stage=0, limit=1)
        
        if not pending:
            return False
            
        # Only run if not already running
        if self.status().status == "running":
            logger.debug("Indexer already running, skipping auto-trigger")
            return False
            
        logger.info("Auto-triggering staged indexer for pending files")
        # Run in background task to not block
        asyncio.create_task(self.refresh_staged(reindex=False))
        return True

    def cancel_folder(self, folder_id: str) -> None:
        """Mark a folder as cancelled to stop processing it."""
        self.state.cancel_folder(folder_id)

    def status(self) -> IndexProgress:
        return self.state.status()

    def pause(self) -> IndexProgress:
        return self.state.pause()

    def resume(self) -> IndexProgress:
        return self.state.resume()

    def indexing_items(self, folder_id: Optional[str] = None) -> list[IndexingItem]:
        return self.state.indexing_items(folder_id)

    # --- Two-Round Scheduling API ---

    def pause_stage(self, stage: str) -> bool:
        """Pause a specific indexing stage.

        Args:
            stage: One of 'fast_text', 'fast_embed', 'deep'
        """
        return self.scheduler.pause_stage(stage)

    def resume_stage(self, stage: str) -> bool:
        """Resume a specific indexing stage.

        Args:
            stage: One of 'fast_text', 'fast_embed', 'deep'
        """
        return self.scheduler.resume_stage(stage)

    def stage_progress(self, folder_id: Optional[str] = None) -> dict:
        """Get progress statistics for all indexing stages."""
        return self.scheduler.get_stage_progress(folder_id)

    def start_semantic(self) -> bool:
        """Start Semantic indexing (embedding generation).

        Semantic is paused by default.
        User must explicitly call this to enable embedding processing.
        """
        return self.scheduler.start_semantic()

    def stop_semantic(self) -> bool:
        """Stop Semantic indexing (embedding generation)."""
        return self.scheduler.stop_semantic()

    def is_semantic_enabled(self) -> bool:
        """Check if Semantic processing is enabled."""
        return self.scheduler.is_semantic_enabled()

    def start_deep(self) -> bool:
        """Start Deep indexing (vision analysis).

        Deep is paused by default to prevent high CPU usage.
        User must explicitly call this to enable Deep processing.
        """
        return self.scheduler.start_deep()

    def stop_deep(self) -> bool:
        """Stop Deep indexing (vision analysis)."""
        return self.scheduler.stop_deep()

    def is_deep_enabled(self) -> bool:
        """Check if Deep processing is enabled."""
        return self.scheduler.is_deep_enabled()

    @property
    def progress(self) -> IndexProgress:
        """Current progress (writable for compatibility)."""
        return self.state.progress

    @progress.setter
    def progress(self, value: IndexProgress) -> None:
        self.state.progress = value

    # --- Orchestration Logic ---

    async def refresh_staged(
        self,
        *,
        folders: Optional[list[str]] = None,
        files: Optional[list[str]] = None,
        skip_pending_registration: bool = False,
        reindex: bool = False,
    ) -> IndexProgress:
        """Refresh using two-round staged indexing.

        This method uses the priority-based scheduler:
        1. All files -> Fast Text (keyword search ready)
        2. All files -> Fast Embedding (vector search ready)
        3. Files one-by-one -> Deep (enhanced search)

        Args:
            folders: Optional list of folder IDs to process
            files: Optional list of file paths to process
            skip_pending_registration: Skip registering pending files
            reindex: If True, reset file stages to force reprocessing

        Returns:
            Index progress status
        """
        if self.state.lock.locked():
            return self.state.progress

        async with self.state.lock:
            self.state.is_paused = False
            self.state.pause_event.set()
            self.state.cancelled_folders.clear()

            targets, target_files_by_folder = self.scanner.resolve_targets(folders, files)

            if not targets:
                now = dt.datetime.now(dt.timezone.utc)
                self.state.progress = IndexProgress(
                    status="failed",
                    started_at=now,
                    completed_at=now,
                    processed=0,
                    message="no-folders",
                    last_error="No folders registered for indexing.",
                )
                return self.state.progress

            # Register pending files for all folders
            total_files = 0
            all_file_paths: list[str] = []
            for folder in targets:
                specific_files = target_files_by_folder.get(folder.id)

                # Check if this folder was explicitly requested (e.g. sent in 'folders' list)
                is_explicit_folder = folders and folder.id in folders

                if specific_files:
                    # Even if specific files are found, if the folder was ALSO requested explicitly,
                    # we should scan the whole folder to be safe (or union them).
                    # Generally explicit folder request overrides specific file request.
                    if is_explicit_folder:
                        folder_paths = list(self.scanner.iter_files(folder.path))
                    else:
                        folder_paths = [p for p in specific_files if p.exists()]
                elif is_explicit_folder:
                    # Folder explicitly requested, scan all
                    folder_paths = list(self.scanner.iter_files(folder.path))
                else:
                    # Fallback: Folder is in targets (likely resolved from 'files'), BUT no specific files
                    # were found in the map. This implies a resolution mismatch.
                    # SAFEGUARD: If we are in 'files' mode (explicit files requested),
                    # DO NOT default to scanning the whole folder.
                    if files:
                        logger.warning(
                            "Folder %s target resolved but no specific files matched. Skipping full scan safety check.",
                            folder.id
                        )
                        continue

                    # Default behavior for folder-based scans (folders=None, files=None -> scan all)
                    folder_paths = list(self.scanner.iter_files(folder.path))

                if not skip_pending_registration:
                    self.scanner.register_pending_files(folder, folder_paths)

                all_file_paths.extend(str(p) for p in folder_paths)
                total_files += len(folder_paths)

            # Reset file stages if reindexing
            if reindex and all_file_paths:
                reset_count = self.storage.reset_file_stages_by_path(
                    all_file_paths, reset_fast=True, reset_deep=False
                )
                logger.info("Reset fast_stage for %d files for reindexing", reset_count)

            # Determine folder_id filter
            # Always use targets (resolved FolderRecords) to get folder_id, not the raw folders parameter
            # which might contain paths instead of folder IDs
            folder_id = None
            if targets and len(targets) == 1:
                folder_id = targets[0].id

            logger.info(
                "Starting staged indexing: %d folders, %d files, reindex=%s",
                len(targets), total_files, reindex
            )

            # Run the scheduler
            result = await self.scheduler.run_continuous(folder_id=folder_id)

            # Mark folders as indexed
            for folder in targets:
                await self._mark_folder_indexed(folder.id)

            return result

    async def refresh(
        self,
        *,
        folders: Optional[list[str]] = None,
        files: Optional[list[str]] = None,
        refresh_embeddings: bool = False,
        drop_collection: bool = False,
        purge_folders: Optional[list[str]] = None,
        indexing_mode: Literal["fast", "deep"] = "fast",
        skip_pending_registration: bool = False,
        skip_recently_indexed_minutes: int = 0,
    ) -> IndexProgress:
        if self.state.lock.locked():
            return self.state.progress

        async with self.state.lock:
            self.state.is_paused = False
            self.state.pause_event.set()
            self.state.cancelled_folders.clear()

            force_reembed = refresh_embeddings or drop_collection

            if drop_collection:
                self.vector_store.drop_collection()

            targets, target_files_by_folder = self.scanner.resolve_targets(folders, files)

            self.state.pending_paths.clear()
            self.state.reset_active_state()

            if not targets:
                now = dt.datetime.now(dt.timezone.utc)
                self.state.current_run_started = now
                self.state.current_run_total = 0
                self.state.current_processed = 0
                self.state.progress = IndexProgress(
                    status="failed",
                    started_at=now,
                    completed_at=now,
                    processed=0,
                    total=None,
                    message="no-folders",
                    last_error="No folders registered for indexing.",
                )
                self.state.pause_event.set()
                self.state.is_paused = False
                return self.state.progress

            purge_targets = set(purge_folders or [])
            if purge_targets:
                for folder in targets:
                    if folder.id in purge_targets:
                        self._purge_folder(folder)

            batches, total_files = self._prepare_batches(
                targets, target_files_by_folder, force_reembed,
                skip_pending_registration=skip_pending_registration,
                skip_recently_indexed_minutes=skip_recently_indexed_minutes,
            )

            started = dt.datetime.now(dt.timezone.utc)
            self.state.current_run_started = started
            self.state.current_run_total = total_files
            self.state.current_processed = 0
            self.state.progress = IndexProgress(
                status="running",
                started_at=started,
                processed=0,
                failed=0,
                total=total_files or None,
            )

            for folder, paths, to_process, reembed, prune_missing_files in batches:
                if folder.id in self.state.cancelled_folders:
                    logger.info("Skipping cancelled folder %s", folder.id)
                    continue

                try:
                    await self._process_folder(
                        folder,
                        refresh_embeddings=reembed,
                        paths=paths,
                        process_paths=to_process,
                        indexing_mode=indexing_mode,
                        prune_missing_files=prune_missing_files,
                    )
                except Exception as exc:
                    self.state.pending_paths.pop(folder.id, None)
                    self.state.reset_active_state()
                    self.state.progress = IndexProgress(
                        status="failed",
                        started_at=started,
                        completed_at=dt.datetime.now(dt.timezone.utc),
                        processed=self.state.current_processed,
                        failed=self.state.progress.failed,
                        failed_items=self.state.progress.failed_items,
                        total=total_files or None,
                        last_error=str(exc),
                        message=self.state.progress.message,
                    )
                    break
                else:
                    await self._mark_folder_indexed(folder.id)
                    current_message = self.state.progress.message
                    self.state.progress = IndexProgress(
                        status="running",
                        started_at=started,
                        processed=self.state.current_processed,
                        failed=self.state.progress.failed,
                        failed_items=self.state.progress.failed_items,
                        total=total_files or None,
                        message=current_message,
                    )
            else:
                final_message = "No changes detected." if total_files == 0 else None
                self.state.progress = IndexProgress(
                    status="completed",
                    started_at=started,
                    completed_at=dt.datetime.now(dt.timezone.utc),
                    processed=self.state.current_processed,
                    failed=self.state.progress.failed,
                    failed_items=self.state.progress.failed_items,
                    total=total_files or None,
                    message=final_message,
                )

            self.state.pending_paths.clear()
            self.state.reset_active_state()
            self.state.pause_event.set()
            self.state.is_paused = False
            return self.state.progress

    def _prepare_batches(
        self,
        targets: list[FolderRecord],
        target_files_by_folder: dict[str, list[Path]],
        refresh_embeddings: bool,
        skip_pending_registration: bool = False,
        skip_recently_indexed_minutes: int = 0,
    ) -> tuple[list[tuple[FolderRecord, list[Path], list[Path], bool, bool]], int]:
        batches: list[tuple[FolderRecord, list[Path], list[Path], bool, bool]] = []
        total_files = 0
        now = dt.datetime.now(dt.timezone.utc)

        for folder in targets:
            # Skip folders that were indexed recently
            if skip_recently_indexed_minutes > 0 and folder.last_indexed_at:
                last_indexed = folder.last_indexed_at
                if last_indexed.tzinfo is None:
                    last_indexed = last_indexed.replace(tzinfo=dt.timezone.utc)
                minutes_since = (now - last_indexed).total_seconds() / 60
                if minutes_since < skip_recently_indexed_minutes:
                    logger.info(
                        "Skipping folder %s - indexed %.1f minutes ago (threshold: %d)",
                        folder.path, minutes_since, skip_recently_indexed_minutes
                    )
                    continue

            specific_files = target_files_by_folder.get(folder.id)
            if specific_files:
                to_process = [p for p in specific_files if p.exists()]
                folder_paths = to_process
                force_reembed_for_files = True
                prune_missing_files = False
            else:
                # Full folder scan
                folder_paths = list(self.scanner.iter_files(folder.path))

                if not skip_pending_registration:
                    self.scanner.register_pending_files(folder, folder_paths)

                to_process = self.scanner.paths_to_refresh(folder, folder_paths, refresh_embeddings=refresh_embeddings)
                force_reembed_for_files = refresh_embeddings
                prune_missing_files = True

            total_files += len(to_process)
            batches.append((folder, folder_paths, to_process, force_reembed_for_files, prune_missing_files))
        return batches, total_files

    async def _process_folder(
            self,
            folder: FolderRecord,
            *,
            refresh_embeddings: bool,
            paths: Optional[list[Path]] = None,
            process_paths: Optional[list[Path]] = None,
            indexing_mode: Literal["fast", "deep"] = "fast",
            prune_missing_files: bool = True,
    ) -> int:
        from collections import deque
        folder_paths = list(paths) if paths is not None else list(self.scanner.iter_files(folder.path))
        process_list = list(process_paths) if process_paths is not None else list(folder_paths)
        if process_list:
            process_list = list(dict.fromkeys(process_list))
            self.state.pending_paths[folder.id] = deque(process_list)
        else:
            self.state.pending_paths.pop(folder.id, None)

        self.state.active_folder = folder
        seen_paths: list[Path] = list(folder_paths)
        processed_count = 0

        if folder.failed_files:
            process_set = set(process_list)
            folder.failed_files = [f for f in folder.failed_files if f.path not in process_set]
            self.storage.upsert_folder(folder)

        for path in process_list:
            if folder.id in self.state.cancelled_folders:
                logger.info("Stopping processing for cancelled folder %s", folder.id)
                break

            await self.state.pause_event.wait()
            pending_queue = self.state.pending_paths.get(folder.id)
            if pending_queue and pending_queue and pending_queue[0] == path:
                pending_queue.popleft()
            self.state.active_folder = folder

            success = await self.processor.process_single_file(folder, path, refresh_embeddings, indexing_mode)
            if success:
                processed_count += 1
                self.state.current_processed += 1
                self.state.set_running_progress()

        if not self.state.pending_paths.get(folder.id):
            self.state.pending_paths.pop(folder.id, None)
        self.state.active_folder = None

        # Only prune missing files after a full folder scan.
        # For single-file rescans/reindexes, `seen_paths` contains only the targeted file(s),
        # and pruning would incorrectly delete all other file records in that folder.
        if prune_missing_files:
            removed_records = self.storage.remove_files_not_in(folder.id, seen_paths)
            for removed in removed_records:
                chunk_ids = removed.metadata.get("vector_chunks", []) if removed.metadata else []
                if chunk_ids:
                    self.vector_store.delete(chunk_ids)
        return processed_count

    def _purge_folder(self, folder: FolderRecord) -> None:
        records = self.storage.folder_files(folder.id)
        if not records:
            return

        chunk_ids: set[str] = set()
        for record in records:
            metadata = record.metadata if isinstance(record.metadata, dict) else {}
            raw_chunks = metadata.get("vector_chunks", []) if isinstance(metadata, dict) else []

            if not raw_chunks:
                chunks = self.storage.chunks_for_file(record.id)
                raw_chunks = [c.chunk_id for c in chunks]

            if isinstance(raw_chunks, list):
                for chunk_id in raw_chunks:
                    if isinstance(chunk_id, str):
                        chunk_ids.add(chunk_id)

        if chunk_ids:
            try:
                self.vector_store.delete(list(chunk_ids))
            except Exception as exc:
                logger.warning("Failed to delete vectors for folder %s: %s", folder.id, exc)

        for record in records:
            self.storage.delete_file(record.id)

        if folder.id.startswith("email::"):
            account_id = folder.id.split("email::", 1)[1]
            if account_id:
                removed = self.storage.prune_missing_email_messages(account_id)
                if removed:
                    logger.info("Pruned %d orphaned email records while purging folder %s", removed, folder.id)

    async def _mark_folder_indexed(self, folder_id: str) -> None:
        folder = self.storage.get_folder(folder_id)
        if not folder:
            return
        now = dt.datetime.now(dt.timezone.utc)
        updated = folder.copy(update={"last_indexed_at": now, "updated_at": now})
        self.storage.upsert_folder(updated)
