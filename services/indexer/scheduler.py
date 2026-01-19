"""Two-Round Scheduler for staged indexing.

Implements strict priority-based scheduling:
1. All files complete Round 1 Stage 1 (Fast Text) first
2. Then all files complete Round 1 Stage 2 (Fast Embedding)
3. Finally, files are processed one-by-one for Round 2 (Deep)

This ensures:
- Keyword search is available ASAP for all files
- Vector search is available next
- Deep processing happens in background without blocking
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from typing import Optional

from services.core.models import IndexProgress
from services.storage import IndexStorage
from .stages import FastTextProcessor, FastEmbedProcessor, DeepProcessor
from .state import StateManager

logger = logging.getLogger(__name__)


class TwoRoundScheduler:
    """Priority-based scheduler for two-round indexing.
    
    Execution order (strict priority):
    1. Fast Text (all files) - enables keyword search
    2. Fast Embedding (all files) - enables vector search  
    3. Deep (one file at a time) - enhances search quality
    
    Supports:
    - Per-stage pause/resume
    - Batch processing for embeddings
    - Graceful cancellation
    """

    def __init__(
        self,
        storage: IndexStorage,
        state_manager: StateManager,
        fast_text_processor: FastTextProcessor,
        fast_embed_processor: FastEmbedProcessor,
        deep_processor: DeepProcessor,
    ) -> None:
        self.storage = storage
        self.state = state_manager
        self.fast_text = fast_text_processor
        self.fast_embed = fast_embed_processor
        self.deep = deep_processor

        # Per-stage pause controls
        # Only fast_text runs by default - user must explicitly enable others
        # This gives users control over resource consumption
        self.paused = {
            "fast_text": False,   # Runs automatically - enables keyword search
            "fast_embed": True,   # Paused by default - user must enable for semantic search
            "deep": True,         # Paused by default - user must enable for vision analysis
        }

        # Batch sizes
        self.fast_text_batch_size = 10
        self.fast_embed_batch_size = 50
        
        # Running state
        self._running = False
        self._cancel_requested = False

    def pause_stage(self, stage: str) -> bool:
        """Pause a specific stage."""
        if stage in self.paused:
            self.paused[stage] = True
            logger.info("Paused stage: %s", stage)
            return True
        return False

    def resume_stage(self, stage: str) -> bool:
        """Resume a specific stage."""
        if stage in self.paused:
            self.paused[stage] = False
            logger.info("Resumed stage: %s", stage)
            return True
        return False

    def is_stage_paused(self, stage: str) -> bool:
        """Check if a stage is paused."""
        return self.paused.get(stage, False)

    def cancel(self) -> None:
        """Request cancellation of current processing."""
        self._cancel_requested = True

    def start_semantic(self) -> bool:
        """Start Semantic indexing (embedding generation).
        
        Semantic is paused by default.
        User must explicitly call this to enable embedding processing.
        
        Returns:
            True if Semantic was started, False if already running
        """
        if not self.paused["fast_embed"]:
            logger.info("Semantic processing is already enabled")
            return False
        
        self.paused["fast_embed"] = False
        logger.info("Semantic processing started by user request")
        return True

    def stop_semantic(self) -> bool:
        """Stop Semantic indexing (embedding generation).
        
        Returns:
            True if Semantic was stopped, False if already paused
        """
        if self.paused["fast_embed"]:
            logger.info("Semantic processing is already paused")
            return False
        
        self.paused["fast_embed"] = True
        logger.info("Semantic processing stopped by user request")
        return True

    def is_semantic_enabled(self) -> bool:
        """Check if Semantic processing is enabled."""
        return not self.paused["fast_embed"]

    def start_deep(self) -> bool:
        """Start Deep indexing (Round 2).
        
        Deep is paused by default to prevent high CPU usage.
        User must explicitly call this to enable Deep processing.
        
        Returns:
            True if Deep was started, False if already running
        """
        if not self.paused["deep"]:
            logger.info("Deep processing is already enabled")
            return False
        
        self.paused["deep"] = False
        logger.info("Deep processing started by user request")
        return True

    def stop_deep(self) -> bool:
        """Stop Deep indexing (Round 2).
        
        Returns:
            True if Deep was stopped, False if already paused
        """
        if self.paused["deep"]:
            logger.info("Deep processing is already paused")
            return False
        
        self.paused["deep"] = True
        logger.info("Deep processing stopped by user request")
        return True

    def is_deep_enabled(self) -> bool:
        """Check if Deep processing is enabled."""
        return not self.paused["deep"]

    async def run_continuous(
        self,
        folder_id: Optional[str] = None,
        max_iterations: Optional[int] = None,
    ) -> IndexProgress:
        """Run the scheduler continuously until all work is done.
        
        Args:
            folder_id: Optional folder to limit processing to
            max_iterations: Optional limit on processing iterations (for testing)
            
        Returns:
            Final index progress status
        """
        self._running = True
        self._cancel_requested = False
        iterations = 0
        
        started = dt.datetime.now(dt.timezone.utc)
        self.state.progress = IndexProgress(
            status="running",
            started_at=started,
            processed=0,
            failed=0,
        )

        try:
            while not self._cancel_requested:
                if max_iterations and iterations >= max_iterations:
                    break

                # Check for pause at global level
                await self.state.pause_event.wait()

                work_done = await self._process_one_round(folder_id)
                
                if not work_done:
                    # No more work to do
                    break

                iterations += 1

            # Completed
            self.state.progress = IndexProgress(
                status="completed",
                started_at=started,
                completed_at=dt.datetime.now(dt.timezone.utc),
                processed=self.state.progress.processed,
                failed=self.state.progress.failed,
                message="All stages completed",
            )

        except Exception as exc:
            logger.exception("Scheduler error: %s", exc)
            self.state.progress = IndexProgress(
                status="failed",
                started_at=started,
                completed_at=dt.datetime.now(dt.timezone.utc),
                processed=self.state.progress.processed,
                failed=self.state.progress.failed,
                last_error=str(exc),
            )

        finally:
            self._running = False

        return self.state.progress

    async def _process_one_round(self, folder_id: Optional[str] = None) -> bool:
        """Process one round of work following strict priority.
        
        Returns True if any work was done, False if nothing to do.
        """
        # ═══════════════════════════════════════════════════════════════
        # Priority 1: Fast Text (all files)
        # ═══════════════════════════════════════════════════════════════
        if not self.paused["fast_text"]:
            pending = self.storage.list_files_by_stage(
                fast_stage=0,
                limit=self.fast_text_batch_size,
                folder_id=folder_id,
            )

            if pending:
                logger.info("Processing %d files for fast_text", len(pending))
                for file_record in pending:
                    if self._cancel_requested:
                        return False
                    await self.state.pause_event.wait()
                    
                    success = await self.fast_text.process(file_record.id)
                    if success:
                        self.state.progress.processed += 1
                    else:
                        self.state.progress.failed += 1
                
                return True  # Work was done, check priority again

        # ═══════════════════════════════════════════════════════════════
        # Priority 2: Fast Embedding (all files with fast_stage=1)
        # ═══════════════════════════════════════════════════════════════
        if not self.paused["fast_embed"]:
            # First check if there are still files pending fast_text
            pending_text = self.storage.list_files_by_stage(
                fast_stage=0, limit=1, folder_id=folder_id
            )
            
            # Only proceed to embedding if no files pending fast_text
            if not pending_text:
                ready = self.storage.list_files_by_stage(
                    fast_stage=1,
                    limit=self.fast_embed_batch_size,
                    folder_id=folder_id,
                )

                if ready:
                    logger.info("Processing %d files for fast_embed (batch mode)", len(ready))
                    
                    if self._cancel_requested:
                        return False
                    await self.state.pause_event.wait()
                    
                    # Use batch processing for better GPU utilization
                    # This collects all chunks from multiple files and embeds them together
                    file_ids = [f.id for f in ready]
                    success_count = await self.fast_embed.process_batch(file_ids)
                    self.state.progress.processed += success_count
                    
                    return True  # Work was done

        # ═══════════════════════════════════════════════════════════════
        # Priority 3: Deep Processing (one file at a time)
        # ═══════════════════════════════════════════════════════════════
        if not self.paused["deep"]:
            # Check if fast round is complete (use folder_id in query for efficiency)
            pending_fast = self.storage.list_files_by_stage(
                fast_stage=0, limit=1, folder_id=folder_id
            )
            pending_embed = self.storage.list_files_by_stage(
                fast_stage=1, limit=1, folder_id=folder_id
            )

            # Only proceed to deep if fast round is complete
            if not pending_fast and not pending_embed:
                ready = self.storage.list_files_by_stage(
                    fast_stage=2,  # Fast round complete
                    deep_stage=0,  # Deep not started
                    limit=1,
                    folder_id=folder_id,
                )

                if ready:
                    file_record = ready[0]
                    logger.info("Processing %s for deep", file_record.name)
                    
                    await self.state.pause_event.wait()
                    success = await self.deep.process(file_record.id)
                    
                    if success:
                        self.state.progress.processed += 1
                    
                    return True  # Work was done

        # No work found in any stage
        return False

    def get_stage_progress(self, folder_id: Optional[str] = None) -> dict:
        """Get progress statistics for all stages.
        
        Returns dict with counts for each stage.
        """
        counts = self.storage.count_files_by_stage(folder_id)
        
        total = counts.get("total", 0)
        
        # Calculate progress percentages
        fast_text_done = counts.get("fast_text_done", 0) + counts.get("fast_embed_done", 0)
        fast_embed_done = counts.get("fast_embed_done", 0)
        deep_done = counts.get("deep_embed_done", 0)
        deep_skipped = counts.get("deep_skipped", 0)
        
        return {
            "total": total,
            "fast_text": {
                "pending": counts.get("fast_pending", 0),
                "done": fast_text_done,
                "error": counts.get("fast_error", 0),
                "percent": (fast_text_done / total * 100) if total > 0 else 0,
            },
            "fast_embed": {
                "pending": counts.get("fast_text_done", 0),  # Files waiting for embed
                "done": fast_embed_done,
                "error": 0,  # Embed errors are retryable
                "percent": (fast_embed_done / total * 100) if total > 0 else 0,
                "enabled": not self.paused["fast_embed"],  # Whether Semantic is enabled
            },
            "deep": {
                "pending": total - deep_done - deep_skipped - counts.get("deep_error", 0),
                "done": deep_done,
                "skipped": deep_skipped,
                "error": counts.get("deep_error", 0),
                "percent": ((deep_done + deep_skipped) / total * 100) if total > 0 else 0,
                "enabled": not self.paused["deep"],  # Whether Deep is enabled
            },
            "paused": dict(self.paused),
            "semantic_enabled": not self.paused["fast_embed"],  # Top-level for easy access
            "deep_enabled": not self.paused["deep"],  # Top-level for easy access
        }

