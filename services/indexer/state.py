"""State management for the indexer."""

from __future__ import annotations

import asyncio
import datetime as dt
from collections import deque
from pathlib import Path
from typing import Optional

from services.core.models import IndexStatus, FolderRecord, IndexProgress, IndexingItem, infer_kind
from ..storage import IndexStorage
from .scanner import fingerprint

class StateManager:
    """Manages the internal state, progress, and pause/resume mechanisms of the indexer."""

    def __init__(self, storage: IndexStorage) -> None:
        self.storage = storage
        self.progress = IndexProgress(status="idle", started_at=None, completed_at=None, processed=0)
        
        # Concurrency control
        self.lock = asyncio.Lock()
        self.pause_event = asyncio.Event()
        self.pause_event.set()
        self.is_paused = False
        self.cancelled_folders: set[str] = set()
        
        # Active processing state
        self.pending_paths: dict[str, deque[Path]] = {}
        self.active_folder: FolderRecord | None = None
        self.active_path: Path | None = None
        self.active_started_at: dt.datetime | None = None
        self.active_progress: float | None = None
        self.active_kind: str | None = None
        self.active_stage: str | None = None
        self.active_detail: str | None = None
        self.active_step_current: int | None = None
        self.active_step_total: int | None = None
        self.active_recent_events: list[dict] = []
        
        # Run stats
        self.current_run_started: dt.datetime | None = None
        self.current_run_total: int = 0
        self.current_processed: int = 0

    def cancel_folder(self, folder_id: str) -> None:
        """Mark a folder as cancelled to stop processing it."""
        self.cancelled_folders.add(folder_id)

    def status(self) -> IndexProgress:
        return self.progress

    def pause(self) -> IndexProgress:
        if self.progress.status != "running" or self.is_paused:
            return self.progress
        self.is_paused = True
        self.pause_event.clear()
        total = self.current_run_total or None
        self.progress = IndexProgress(
            status="paused",
            started_at=self.current_run_started,
            completed_at=None,
            processed=self.current_processed,
            failed=self.progress.failed,
            failed_items=self.progress.failed_items,
            total=total,
            message="Indexing paused.",
            last_error=self.progress.last_error,
        )
        return self.progress

    def resume(self) -> IndexProgress:
        if not self.is_paused:
            return self.progress
        self.is_paused = False
        self.pause_event.set()
        self.set_running_progress(message="Resuming indexing…")
        return self.progress

    def set_running_progress(self, *, message: Optional[str] = None) -> None:
        if not self.current_run_started:
            return
        total = self.current_run_total or None
        current_message = message if message is not None else self.progress.message
        self.progress = IndexProgress(
            status="running",
            started_at=self.current_run_started,
            completed_at=None,
            processed=self.current_processed,
            failed=self.progress.failed,
            failed_items=self.progress.failed_items,
            total=total,
            message=current_message,
        )

    def set_active_stage(
        self,
        *,
        stage: str | None,
        detail: str | None = None,
        step_current: int | None = None,
        step_total: int | None = None,
        progress: float | None = None,
        event: str | None = None,
        event_type: str = "info",
        event_payload: dict | None = None,
    ) -> None:
        self.active_stage = stage
        self.active_detail = detail
        self.active_step_current = step_current
        self.active_step_total = step_total
        if progress is not None:
            self.active_progress = progress

        if event is not None:
            payload = {
                "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
                "type": event_type,
                "message": event,
            }
            if event_payload:
                payload.update(event_payload)
            self.active_recent_events.append(payload)
            if len(self.active_recent_events) > 100:
                self.active_recent_events = self.active_recent_events[-100:]

    def indexing_items(self, folder_id: Optional[str] = None) -> list[IndexingItem]:
        items: list[IndexingItem] = []
        if self.active_folder and self.active_path:
            if folder_id is None or self.active_folder.id == folder_id:
                # Get file ID for reliable matching
                active_file_id = fingerprint(self.active_path) if self.active_path.exists() else None
                items.append(
                    IndexingItem(
                        folder_id=self.active_folder.id,
                        folder_path=self.active_folder.path,
                        file_path=self.active_path,
                        file_id=active_file_id,
                        file_name=self.active_path.name,
                        status="processing",
                        started_at=self.active_started_at,
                        progress=self.active_progress,
                        kind=self.active_kind,
                        stage=self.active_stage,
                        detail=self.active_detail,
                        step_current=self.active_step_current,
                        step_total=self.active_step_total,
                        recent_events=list(self.active_recent_events)[-25:],
                    )
                )

        for fid, pending in self.pending_paths.items():
            if folder_id and fid != folder_id:
                continue
            if self.active_folder and self.active_folder.id == fid:
                folder = self.active_folder
            else:
                folder = self.storage.get_folder(fid)
            if not folder:
                continue
            for path in list(pending):
                pending_file_id = fingerprint(path) if path.exists() else None
                items.append(
                    IndexingItem(
                        folder_id=fid,
                        folder_path=folder.path,
                        file_path=path,
                        file_id=pending_file_id,
                        file_name=path.name,
                        status="pending",
                        kind=infer_kind(path),
                        stage="pending",
                    )
                )

        return items

    def set_active_file(
        self,
        *,
        folder_id: str | None = None,
        folder_path: str | Path | None = None,
        file_path: str | Path | None = None,
        file_name: str | None = None,
        kind: str | None = None,
    ) -> None:
        """Set the active file being processed (for embedding/deep stages).
        
        This allows progress to be shown even when processing isn't 
        driven by folder scanning.
        """
        if file_path:
            self.active_path = Path(file_path) if isinstance(file_path, str) else file_path
            self.active_started_at = dt.datetime.now(dt.timezone.utc)
        if kind:
            self.active_kind = kind
        
        # Get folder from storage if we have folder_id
        if folder_id:
            folder = self.storage.get_folder(folder_id)
            if folder:
                self.active_folder = folder

    def reset_active_state(self):
        """Reset the active file state after processing."""
        self.active_folder = None
        self.active_path = None
        self.active_started_at = None
        self.active_progress = None
        self.active_kind = None
        self.active_stage = None
        self.active_detail = None
        self.active_step_current = None
        self.active_step_total = None
        self.active_recent_events = []
