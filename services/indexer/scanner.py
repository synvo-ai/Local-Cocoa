"""File scanning and discovery logic for the indexer."""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
from pathlib import Path
from typing import Iterable, Optional, Sequence

from services.core.config import settings
from services.core.models import FileRecord, FolderRecord, FailedFile, infer_kind
from services.storage import IndexStorage

logger = logging.getLogger(__name__)


def fingerprint(path: Path) -> str:
    """Generate a consistent file hash based on its absolute path."""
    digest = hashlib.sha1()
    digest.update(str(path.resolve()).encode("utf-8"))
    return digest.hexdigest()


def checksum(path: Path) -> str:
    """Read the file content to compute a SHA-256 checksum."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Scanner:
    """Handles file discovery, filtering, and registration."""

    def __init__(self, storage: IndexStorage) -> None:
        self.storage = storage

    def iter_files(self, base: Path, *, max_files: Optional[int] = None) -> Iterable[Path]:
        """
        Iterate over files in the folder.
        
        Args:
            base: The folder path to scan
            max_files: Optional limit on number of files to yield
        """
        root = base.expanduser().resolve()
        if not root.exists():
            return
        base_depth = len(root.parts)
        file_count = 0
        for current_root, dirs, files in os.walk(root, followlinks=settings.follow_symlinks):
            depth = len(Path(current_root).parts) - base_depth
            if depth >= settings.max_depth:
                dirs[:] = []
            for filename in files:
                # Skip hidden files
                if filename.startswith("."):
                    continue
                path = Path(current_root) / filename
                if not path.is_file():
                    continue
                yield path
                file_count += 1
                if max_files is not None and file_count >= max_files:
                    return

    def select_folders(self, folder_ids: Optional[list[str]], include_manual: bool = False) -> list[FolderRecord]:
        """Select folders to be indexed."""
        folders = [folder for folder in self.storage.list_folders() if folder.enabled]
        
        if folder_ids:
            allowed = set(folder_ids)
            return [folder for folder in folders if folder.id in allowed]
        
        if not include_manual:
            folders = [f for f in folders if f.scan_mode != "manual"]
        
        return folders

    def resolve_targets(
        self, folders: Optional[list[str]], files: Optional[list[str]]
    ) -> tuple[list[FolderRecord], dict[str, list[Path]]]:
        """
        Resolve which folders and files should be targeted.
        Returns:
            (target_folders_list, map_of_folder_id_to_specific_file_paths)
        """
        target_files_by_folder: dict[str, list[Path]] = {}
        is_explicit_request = bool(files) or bool(folders)
        
        if files:
            for file_path_str in files:
                path = Path(file_path_str).resolve()
                folder = self.storage.folder_by_path(path.parent)
                # If not found directly, try to find which folder contains this file
                if not folder:
                    all_folders = self.storage.list_folders()
                    for f in all_folders:
                        try:
                            path.relative_to(f.path)
                            folder = f
                            break
                        except ValueError:
                            continue

                if folder:
                    if folder.id not in target_files_by_folder:
                        target_files_by_folder[folder.id] = []
                    target_files_by_folder[folder.id].append(path)

            if target_files_by_folder:
                folders = list(target_files_by_folder.keys())

        targets = self.select_folders(folders, include_manual=is_explicit_request)
        return targets, target_files_by_folder

    def register_pending_files(self, folder: FolderRecord, paths: list[Path]) -> None:
        """Register all discovered files as pending in the database using batch operations."""
        if not paths:
            return

        records_to_insert: list[FileRecord] = []
        file_ids: list[str] = []

        for path in paths:
            try:
                # Use standalone fingerprint function
                file_hash = fingerprint(path)
                file_ids.append(file_hash)
            except OSError:
                continue

        existing_ids = self.storage.get_existing_file_ids(file_ids)

        for path in paths:
            try:
                file_hash = fingerprint(path)
                if file_hash in existing_ids:
                    continue

                stat = path.stat()
                extension = path.suffix.lower().lstrip(".")
                kind = infer_kind(path)

                record = FileRecord(
                    id=file_hash,
                    folder_id=folder.id,
                    path=path,
                    name=path.name,
                    extension=extension,
                    size=stat.st_size,
                    modified_at=dt.datetime.fromtimestamp(stat.st_mtime, tz=dt.timezone.utc),
                    created_at=dt.datetime.fromtimestamp(stat.st_ctime, tz=dt.timezone.utc),
                    kind=kind,
                    hash=file_hash,
                    index_status="pending",
                    # Inherit privacy level from parent folder
                    privacy_level=folder.privacy_level,
                )
                records_to_insert.append(record)
            except OSError:
                continue

        if records_to_insert:
            self.storage.register_pending_files_batch(records_to_insert)

    def paths_to_refresh(
        self,
        folder: FolderRecord,
        paths: Sequence[Path],
        *,
        refresh_embeddings: bool,
    ) -> list[Path]:
        """Identify which paths actually need refreshing based on size, mtime, or status."""
        if refresh_embeddings:
            return list(paths)

        failed_paths = {f.path for f in folder.failed_files}
        changed: list[Path] = []
        
        for path in paths:
            if path in failed_paths:
                changed.append(path)
                continue

            file_id = fingerprint(path)
            existing = self.storage.get_file(file_id)
            if not existing:
                changed.append(path)
                continue

            try:
                stat = path.stat()
            except OSError:
                changed.append(path)
                continue

            modified = dt.datetime.fromtimestamp(stat.st_mtime, tz=dt.timezone.utc)
            existing_modified = existing.modified_at
            if existing_modified.tzinfo is None:
                existing_modified = existing_modified.replace(tzinfo=dt.timezone.utc)

            if abs((modified - existing_modified).total_seconds()) >= 1:
                changed.append(path)
                continue

            if existing.size != stat.st_size:
                changed.append(path)
                continue

            if not existing.checksum_sha256:
                changed.append(path)

        return changed
