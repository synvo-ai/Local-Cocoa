"""File and Folder storage operations."""

from __future__ import annotations

import datetime as dt
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from services.core.models import ChunkSnapshot, FileRecord, FolderRecord, FailedFile
from services.core.request_context import RequestContext, get_request_context

logger = logging.getLogger(__name__)


class FileMixin:
    """Mixin for handling files, folders, and chunks."""

    def _ensure_folder_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(folders)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE folders ADD COLUMN {name} {definition}")

        add_column("failed_files", "TEXT")
        add_column("scan_mode", "TEXT NOT NULL DEFAULT 'full'")

    def _ensure_file_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(files)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE files ADD COLUMN {name} {definition}")

        add_column("mime_type", "TEXT")
        add_column("checksum_sha256", "TEXT")
        add_column("duration_seconds", "REAL")
        add_column("page_count", "INTEGER")
        add_column("preview_image", "BLOB")
        add_column("metadata", "TEXT")
        
        if "index_status" not in existing:
            conn.execute("ALTER TABLE files ADD COLUMN index_status TEXT NOT NULL DEFAULT 'indexed'")
        
        # Migration for pending status
        conn.execute("""
            UPDATE files SET index_status = 'indexed' 
            WHERE index_status = 'pending' 
            AND (embedding_vector IS NOT NULL OR summary IS NOT NULL OR (metadata IS NOT NULL AND metadata != '{}'))
        """)
        
        add_column("error_reason", "TEXT")
        add_column("error_at", "TEXT")
        
        # Two-round indexing stage columns
        # Round 1 (Fast): 0=pending, 1=text_done, 2=embed_done, -1=error
        add_column("fast_stage", "INTEGER NOT NULL DEFAULT 0")
        add_column("fast_text_at", "TEXT")
        add_column("fast_embed_at", "TEXT")
        
        # Round 2 (Deep): 0=pending, 1=text_done, 2=embed_done, -1=error, -2=skipped
        add_column("deep_stage", "INTEGER NOT NULL DEFAULT 0")
        add_column("deep_text_at", "TEXT")
        add_column("deep_embed_at", "TEXT")
        
        # Migration: existing indexed files should have fast_stage=2 (fully indexed in old system)
        conn.execute("""
            UPDATE files SET fast_stage = 2, deep_stage = 0
            WHERE index_status = 'indexed' AND fast_stage = 0
            AND (embedding_vector IS NOT NULL OR summary IS NOT NULL)
        """)

    def _ensure_chunk_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(chunks)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE chunks ADD COLUMN {name} {definition}")

        add_column("section_path", "TEXT")
        add_column("metadata", "TEXT")
        # Chunk version: "fast" = Round 1, "deep" = Round 2
        add_column("version", "TEXT NOT NULL DEFAULT 'fast'")

    # --- Folders ---

    def upsert_folder(self, record: FolderRecord) -> None:
        failed_files_json = json.dumps([f.dict() for f in record.failed_files], default=str) if record.failed_files else None
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO folders (id, path, label, created_at, updated_at, last_indexed_at, enabled, failed_files, scan_mode, privacy_level)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    path=excluded.path,
                    label=excluded.label,
                    updated_at=excluded.updated_at,
                    last_indexed_at=excluded.last_indexed_at,
                    enabled=excluded.enabled,
                    failed_files=excluded.failed_files,
                    scan_mode=excluded.scan_mode,
                    privacy_level=excluded.privacy_level
                """,
                (
                    record.id,
                    str(record.path),
                    record.label,
                    record.created_at.isoformat(),
                    record.updated_at.isoformat(),
                    record.last_indexed_at.isoformat() if record.last_indexed_at else None,
                    1 if record.enabled else 0,
                    failed_files_json,
                    record.scan_mode,
                    record.privacy_level,
                ),
            )

    def remove_folder(self, folder_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))

    def list_folders(self) -> list[FolderRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                """
                SELECT f.*, (SELECT COUNT(*) FROM files WHERE folder_id = f.id) as indexed_count
                FROM folders f
                ORDER BY f.created_at ASC
                """
            ).fetchall()
        return [self._row_to_folder(row) for row in rows]

    def get_folder(self, folder_id: str) -> Optional[FolderRecord]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                """
                SELECT f.*, (SELECT COUNT(*) FROM files WHERE folder_id = f.id) as indexed_count
                FROM folders f
                WHERE f.id = ?
                """,
                (folder_id,)
            ).fetchone()
        return self._row_to_folder(row) if row else None

    def folder_by_path(self, path: Path) -> Optional[FolderRecord]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                """
                SELECT f.*, (SELECT COUNT(*) FROM files WHERE folder_id = f.id) as indexed_count
                FROM folders f
                WHERE f.path = ?
                """,
                (str(path),)
            ).fetchone()
        return self._row_to_folder(row) if row else None
    
    def folder_file_count(self, folder_id: str) -> int:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                "SELECT COUNT(*) FROM files WHERE folder_id = ?",
                (folder_id,),
            ).fetchone()
        return int(row[0] if row else 0)

    # --- Files ---

    def register_pending_files_batch(self, records: list[FileRecord]) -> int:
        if not records:
            return 0
        with self.connect() as conn:  # type: ignore
            cursor = conn.executemany(
                """
                INSERT OR IGNORE INTO files (
                    id, folder_id, path, name, extension, size, modified_at, created_at, kind, hash,
                    index_status, error_reason, error_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
                """,
                [
                    (
                        record.id,
                        record.folder_id,
                        str(record.path),
                        record.name,
                        record.extension,
                        record.size,
                        record.modified_at.isoformat(),
                        record.created_at.isoformat(),
                        record.kind,
                        record.hash,
                    )
                    for record in records
                ],
            )
            return cursor.rowcount

    def get_existing_file_ids(self, file_ids: list[str]) -> set[str]:
        if not file_ids:
            return set()
        with self.connect() as conn:  # type: ignore
            existing: set[str] = set()
            batch_size = 500
            for i in range(0, len(file_ids), batch_size):
                batch = file_ids[i:i + batch_size]
                placeholders = ",".join("?" for _ in batch)
                rows = conn.execute(
                    f"SELECT id FROM files WHERE id IN ({placeholders})",
                    batch,
                ).fetchall()
                existing.update(row["id"] for row in rows)
            return existing

    def upsert_file(self, record: FileRecord) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO files (
                    id, folder_id, path, name, extension, size, modified_at, created_at, kind, hash, summary,
                    embedding_vector, embedding_determined_at, mime_type, checksum_sha256, duration_seconds,
                    page_count, preview_image, metadata, index_status, error_reason, error_at,
                    fast_stage, fast_text_at, fast_embed_at, deep_stage, deep_text_at, deep_embed_at, privacy_level
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    folder_id=excluded.folder_id,
                    path=excluded.path,
                    name=excluded.name,
                    extension=excluded.extension,
                    size=excluded.size,
                    modified_at=excluded.modified_at,
                    created_at=excluded.created_at,
                    kind=excluded.kind,
                    hash=excluded.hash,
                    summary=excluded.summary,
                    embedding_vector=excluded.embedding_vector,
                    embedding_determined_at=excluded.embedding_determined_at,
                    mime_type=excluded.mime_type,
                    checksum_sha256=excluded.checksum_sha256,
                    duration_seconds=excluded.duration_seconds,
                    page_count=excluded.page_count,
                    preview_image=excluded.preview_image,
                    metadata=excluded.metadata,
                    index_status=excluded.index_status,
                    error_reason=excluded.error_reason,
                    error_at=excluded.error_at,
                    fast_stage=excluded.fast_stage,
                    fast_text_at=excluded.fast_text_at,
                    fast_embed_at=excluded.fast_embed_at,
                    deep_stage=excluded.deep_stage,
                    deep_text_at=excluded.deep_text_at,
                    deep_embed_at=excluded.deep_embed_at,
                    privacy_level=excluded.privacy_level
                """,
                (
                    record.id,
                    record.folder_id,
                    str(record.path),
                    record.name,
                    record.extension,
                    record.size,
                    record.modified_at.isoformat(),
                    record.created_at.isoformat(),
                    record.kind,
                    record.hash,
                    record.summary,
                    self._serialize_vector(record.embedding_vector),
                    record.embedding_determined_at.isoformat() if record.embedding_determined_at else None,
                    record.mime_type,
                    record.checksum_sha256,
                    record.duration_seconds,
                    record.page_count,
                    record.preview_image,
                    self._serialize_metadata(record.metadata),
                    record.index_status,
                    record.error_reason,
                    record.error_at.isoformat() if record.error_at else None,
                    record.fast_stage,
                    record.fast_text_at.isoformat() if record.fast_text_at else None,
                    record.fast_embed_at.isoformat() if record.fast_embed_at else None,
                    record.deep_stage,
                    record.deep_text_at.isoformat() if record.deep_text_at else None,
                    record.deep_embed_at.isoformat() if record.deep_embed_at else None,
                    record.privacy_level,
                ),
            )

    def mark_file_indexed(self, file_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                "UPDATE files SET index_status = 'indexed', error_reason = NULL, error_at = NULL WHERE id = ?",
                (file_id,),
            )

    def mark_file_error(self, file_id: str, error_reason: str) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        with self.connect() as conn:  # type: ignore
            conn.execute(
                "UPDATE files SET index_status = 'error', error_reason = ?, error_at = ? WHERE id = ?",
                (error_reason, now.isoformat(), file_id),
            )

    def reset_file_for_reindex(self, file_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                "UPDATE files SET index_status = 'pending', error_reason = NULL, error_at = NULL WHERE id = ?",
                (file_id,),
            )

    def list_files(self, limit: int = 100, offset: int = 0, folder_id: Optional[str] = None) -> tuple[list[FileRecord], int]:
        query = "SELECT * FROM files"
        params: list[object] = []
        if folder_id:
            query += " WHERE folder_id = ?"
            params.append(folder_id)
        query += " ORDER BY modified_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
            cursor = conn.execute(
                "SELECT COUNT(*) FROM files" + (" WHERE folder_id = ?" if folder_id else ""),
                ([folder_id] if folder_id else []),
            )
            total = cursor.fetchone()[0]
        return [self._row_to_file(row) for row in rows], int(total)

    def get_files_in_folder(self, folder_id: str, limit: int = 10000) -> list[FileRecord]:
        """
        Get all files in a specific folder.
        Used for scope isolation in search/QA (e.g., benchmark test mode).
        
        Args:
            folder_id: The folder ID to filter by
            limit: Maximum number of files to return (default 10000)
            
        Returns:
            List of FileRecord objects in the folder
        """
        query = "SELECT * FROM files WHERE folder_id = ? ORDER BY modified_at DESC LIMIT ?"
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, (folder_id, limit)).fetchall()
        return [self._row_to_file(row) for row in rows]

    def get_file(
        self,
        file_id: str,
        ctx: Optional[RequestContext] = None,
        check_privacy: bool = True,
    ) -> Optional[FileRecord]:
        """
        Get a file by ID with optional privacy check.

        Args:
            file_id: The file ID
            ctx: Optional request context for privacy filtering
            check_privacy: If True, returns None for private files when ctx is external
        """
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        
        if not row:
            return None
        
        record = self._row_to_file(row)
        
        # Privacy check - return None (as if not found) for private files on external requests
        # This prevents leaking information about file existence
        if check_privacy:
            if ctx is None:
                ctx = get_request_context()
            if record.privacy_level == "private" and not ctx.can_access_private:
                logger.debug(f"Privacy check blocked access to file {file_id}")
                return None
        
        return record

    def get_file_by_path(
        self, 
        path: Path | str,
        ctx: Optional[RequestContext] = None,
        check_privacy: bool = True,
    ) -> Optional[FileRecord]:
        """
        Get a file by path with optional privacy check.
        
        Args:
            path: The file path
            ctx: Optional request context for privacy filtering
            check_privacy: If True, returns None for private files when ctx is external
        """
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM files WHERE path = ?", (str(path),)).fetchone()
        
        if not row:
            return None
        
        record = self._row_to_file(row)
        
        # Privacy check
        if check_privacy:
            if ctx is None:
                ctx = get_request_context()
            if record.privacy_level == "private" and not ctx.can_access_private:
                return None
        
        return record

    def get_file_by_chunk_id(self, chunk_id: str) -> Optional[FileRecord]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                """
                SELECT f.* FROM files f
                JOIN chunks c ON c.file_id = f.id
                WHERE c.id = ?
                LIMIT 1
                """,
                (chunk_id,)
            ).fetchone()
        return self._row_to_file(row) if row else None

    def remove_files_not_in(self, folder_id: str, keep_paths: Iterable[Path]) -> list[FileRecord]:
        keep = {str(p) for p in keep_paths}
        removed: list[FileRecord] = []
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM files WHERE folder_id = ?",
                (folder_id,),
            ).fetchall()
            for row in rows:
                if row["path"] not in keep:
                    record = self._row_to_file(row)
                    
                    metadata = record.metadata or {}
                    if "vector_chunks" not in metadata or not metadata["vector_chunks"]:
                        chunk_rows = conn.execute("SELECT id FROM chunks WHERE file_id = ?", (record.id,)).fetchall()
                        chunk_ids = [r["id"] for r in chunk_rows]
                        if chunk_ids:
                            metadata["vector_chunks"] = chunk_ids
                            record.metadata = metadata

                    conn.execute("DELETE FROM chunks WHERE file_id = ?", (record.id,))
                    conn.execute("DELETE FROM files WHERE id = ?", (record.id,))
                    removed.append(record)
        return removed

    def delete_file(self, file_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute("DELETE FROM chunks WHERE file_id = ?", (file_id,))
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))

    # --- Privacy Level Management ---
    
    def update_file_privacy(self, file_id: str, privacy_level: str) -> bool:
        """
        Update the privacy level of a file.
        
        Args:
            file_id: The file ID
            privacy_level: The new privacy level ("normal" or "private")
            
        Returns:
            True if the file was updated, False if not found
        """
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(
                "UPDATE files SET privacy_level = ? WHERE id = ?",
                (privacy_level, file_id),
            )
            return cursor.rowcount > 0
    
    def update_folder_privacy(self, folder_id: str, privacy_level: str) -> bool:
        """
        Update the privacy level of a folder.
        
        Args:
            folder_id: The folder ID
            privacy_level: The new privacy level ("normal" or "private")
            
        Returns:
            True if the folder was updated, False if not found
        """
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(
                "UPDATE folders SET privacy_level = ? WHERE id = ?",
                (privacy_level, folder_id),
            )
            return cursor.rowcount > 0
    
    def update_folder_files_privacy(self, folder_id: str, privacy_level: str) -> int:
        """
        Update the privacy level of all files in a folder.
        
        Args:
            folder_id: The folder ID
            privacy_level: The new privacy level ("normal" or "private")
            
        Returns:
            Number of files updated
        """
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(
                "UPDATE files SET privacy_level = ? WHERE folder_id = ?",
                (privacy_level, folder_id),
            )
            return cursor.rowcount
    
    def list_private_files(self, folder_id: Optional[str] = None) -> list[FileRecord]:
        """
        List all files marked as private.
        
        Args:
            folder_id: Optional folder filter
            
        Returns:
            List of private FileRecords
        """
        query = "SELECT * FROM files WHERE privacy_level = 'private'"
        params: list[object] = []
        if folder_id:
            query += " AND folder_id = ?"
            params.append(folder_id)
        query += " ORDER BY modified_at DESC"
        
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
        return [self._row_to_file(row) for row in rows]

    def list_pending_files(self, folder_id: Optional[str] = None) -> list[FileRecord]:
        query = "SELECT * FROM files WHERE index_status = 'pending'"
        params: list[object] = []
        if folder_id:
            query += " AND folder_id = ?"
            params.append(folder_id)
        query += " ORDER BY modified_at DESC"
        
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
        return [self._row_to_file(row) for row in rows]

    def list_error_files(self, folder_id: Optional[str] = None) -> list[FileRecord]:
        query = "SELECT * FROM files WHERE index_status = 'error'"
        params: list[object] = []
        if folder_id:
            query += " AND folder_id = ?"
            params.append(folder_id)
        query += " ORDER BY error_at DESC"
        
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
        return [self._row_to_file(row) for row in rows]

    # --- Two-Round Indexing Stage Queries ---
    
    def list_files_by_stage(
        self,
        fast_stage: Optional[int] = None,
        deep_stage: Optional[int] = None,
        limit: int = 100,
        folder_id: Optional[str] = None,
    ) -> list[FileRecord]:
        """Query files by their indexing stage.
        
        Args:
            fast_stage: Filter by fast_stage value (0=pending, 1=text_done, 2=embed_done, -1=error)
            deep_stage: Filter by deep_stage value (0=pending, 1=text_done, 2=embed_done, -1=error, -2=skipped)
            limit: Maximum number of files to return
            folder_id: Optional folder filter
        """
        conditions = []
        params: list[object] = []
        
        if fast_stage is not None:
            conditions.append("fast_stage = ?")
            params.append(fast_stage)
        if deep_stage is not None:
            conditions.append("deep_stage = ?")
            params.append(deep_stage)
        if folder_id:
            conditions.append("folder_id = ?")
            params.append(folder_id)
        
        where_clause = " AND ".join(conditions) if conditions else "1=1"
        query = f"SELECT * FROM files WHERE {where_clause} ORDER BY modified_at DESC LIMIT ?"
        params.append(limit)
        
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
        return [self._row_to_file(row) for row in rows]

    def count_files_by_stage(self, folder_id: Optional[str] = None) -> dict[str, int]:
        """Get counts of files at each stage for progress display.
        
        Returns dict with keys like:
        - fast_pending, fast_text_done, fast_embed_done, fast_error
        - deep_pending, deep_text_done, deep_embed_done, deep_skipped, deep_error
        """
        base_condition = "WHERE folder_id = ?" if folder_id else ""
        params: tuple = (folder_id,) if folder_id else ()
        
        with self.connect() as conn:  # type: ignore
            result = {}
            
            # Fast stage counts
            for stage, name in [(0, "pending"), (1, "text_done"), (2, "embed_done"), (-1, "error")]:
                query = f"SELECT COUNT(*) FROM files {base_condition} {'AND' if folder_id else 'WHERE'} fast_stage = ?"
                count = conn.execute(query, params + (stage,)).fetchone()[0]
                result[f"fast_{name}"] = count
            
            # Deep stage counts
            for stage, name in [(0, "pending"), (1, "text_done"), (2, "embed_done"), (-1, "error"), (-2, "skipped")]:
                query = f"SELECT COUNT(*) FROM files {base_condition} {'AND' if folder_id else 'WHERE'} deep_stage = ?"
                count = conn.execute(query, params + (stage,)).fetchone()[0]
                result[f"deep_{name}"] = count
            
            # Total
            query = f"SELECT COUNT(*) FROM files {base_condition}" if folder_id else "SELECT COUNT(*) FROM files"
            result["total"] = conn.execute(query, params).fetchone()[0]
            
        return result

    def update_file_stage(
        self,
        file_id: str,
        fast_stage: Optional[int] = None,
        fast_text_at: Optional[dt.datetime] = None,
        fast_embed_at: Optional[dt.datetime] = None,
        deep_stage: Optional[int] = None,
        deep_text_at: Optional[dt.datetime] = None,
        deep_embed_at: Optional[dt.datetime] = None,
    ) -> None:
        """Update file indexing stage without full upsert."""
        updates = []
        params: list[object] = []
        
        if fast_stage is not None:
            updates.append("fast_stage = ?")
            params.append(fast_stage)
        if fast_text_at is not None:
            updates.append("fast_text_at = ?")
            params.append(fast_text_at.isoformat())
        if fast_embed_at is not None:
            updates.append("fast_embed_at = ?")
            params.append(fast_embed_at.isoformat())
        if deep_stage is not None:
            updates.append("deep_stage = ?")
            params.append(deep_stage)
        if deep_text_at is not None:
            updates.append("deep_text_at = ?")
            params.append(deep_text_at.isoformat())
        if deep_embed_at is not None:
            updates.append("deep_embed_at = ?")
            params.append(deep_embed_at.isoformat())
        
        if not updates:
            return
            
        params.append(file_id)
        query = f"UPDATE files SET {', '.join(updates)} WHERE id = ?"
        
        with self.connect() as conn:  # type: ignore
            conn.execute(query, params)

    def reset_file_stages_by_path(
        self,
        paths: list[str],
        reset_fast: bool = True,
        reset_deep: bool = False,
    ) -> int:
        """Reset file indexing stages for reindexing.
        
        Also deletes old chunks of the reset versions to ensure clean reindexing.
        
        Args:
            paths: List of file paths to reset
            reset_fast: Reset fast_stage to 0 and delete fast chunks
            reset_deep: Reset deep_stage to 0 and delete deep chunks
            
        Returns:
            Number of files updated
        """
        if not paths:
            return 0
            
        updates = []
        versions_to_delete = []
        if reset_fast:
            updates.append("fast_stage = 0")
            updates.append("fast_text_at = NULL")
            updates.append("fast_embed_at = NULL")
            versions_to_delete.append("fast")
        if reset_deep:
            updates.append("deep_stage = 0")
            updates.append("deep_text_at = NULL")
            updates.append("deep_embed_at = NULL")
            versions_to_delete.append("deep")
            
        if not updates:
            return 0
        
        # Build parameterized query
        placeholders = ', '.join('?' for _ in paths)
        
        with self.connect() as conn:  # type: ignore
            # First, get file IDs for these paths
            file_ids = conn.execute(
                f"SELECT id FROM files WHERE path IN ({placeholders})",
                paths
            ).fetchall()
            file_id_list = [row["id"] for row in file_ids]
            
            # Delete old chunks for these files (by version)
            if file_id_list and versions_to_delete:
                file_placeholders = ', '.join('?' for _ in file_id_list)
                for version in versions_to_delete:
                    conn.execute(
                        f"DELETE FROM chunks WHERE file_id IN ({file_placeholders}) AND version = ?",
                        file_id_list + [version]
                    )
            
            # Update file stages
            query = f"UPDATE files SET {', '.join(updates)} WHERE path IN ({placeholders})"
            cursor = conn.execute(query, paths)
            return cursor.rowcount

    def folder_files(self, folder_id: str) -> list[FileRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM files WHERE folder_id = ? ORDER BY modified_at DESC",
                (folder_id,),
            ).fetchall()
        return [self._row_to_file(row) for row in rows]

    def get_recent_files_with_suggestions(self, limit: int = 5) -> list[FileRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                """
                SELECT * FROM files 
                WHERE json_extract(metadata, '$.suggested_questions') IS NOT NULL
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,)
            ).fetchall()
        return [self._row_to_file(row) for row in rows]

    def files_with_embeddings(self) -> list[FileRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute("SELECT * FROM files WHERE embedding_vector IS NOT NULL").fetchall()
        return [self._row_to_file(row) for row in rows]

    def find_files_by_name(self, name_pattern: str) -> list[FileRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM files WHERE name LIKE ?",
                (f"%{name_pattern}%",),
            ).fetchall()
        return [self._row_to_file(row) for row in rows]

    def total_size(self, folder_id: Optional[str] = None) -> int:
        query = "SELECT COALESCE(SUM(size), 0) FROM files"
        params: tuple[str, ...] = ()
        if folder_id:
            query += " WHERE folder_id = ?"
            params = (folder_id,)
        with self.connect() as conn:  # type: ignore
            result = conn.execute(query, params).fetchone()[0]
        return int(result or 0)

    def counts(self) -> tuple[int, int]:
        with self.connect() as conn:  # type: ignore
            files = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
            folders = conn.execute("SELECT COUNT(*) FROM folders WHERE enabled = 1").fetchone()[0]
        return int(files), int(folders)

    # --- Chunks ---

    def replace_chunks(self, file_id: str, chunks: list[ChunkSnapshot], version: str = "fast") -> None:
        """Replace all chunks for a file with new chunks.
        
        Args:
            file_id: The file ID to replace chunks for
            chunks: List of new chunks
            version: Only delete chunks of this version ("fast" or "deep"). 
                     If None, deletes all chunks for the file.
        """
        with self.connect() as conn:  # type: ignore
            # Only delete chunks of the same version
            conn.execute("DELETE FROM chunks WHERE file_id = ? AND version = ?", (file_id, version))
            if not chunks:
                return
            conn.executemany(
                """
                INSERT INTO chunks (id, file_id, ordinal, text, snippet, token_count, char_count, section_path, metadata, created_at, version, privacy_level)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        chunk.chunk_id,
                        chunk.file_id,
                        chunk.ordinal,
                        chunk.text,
                        chunk.snippet,
                        chunk.token_count,
                        chunk.char_count,
                        chunk.section_path,
                        self._serialize_metadata(chunk.metadata),
                        chunk.created_at.isoformat(),
                        chunk.version,
                        chunk.privacy_level,
                    )
                    for chunk in chunks
                ],
            )

    def chunks_for_file(self, file_id: str) -> list[ChunkSnapshot]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM chunks WHERE file_id = ? ORDER BY ordinal ASC",
                (file_id,),
            ).fetchall()
        return [self._row_to_chunk(row) for row in rows]

    def get_chunk(self, chunk_id: str) -> Optional[ChunkSnapshot]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM chunks WHERE id = ?", (chunk_id,)).fetchone()
        return self._row_to_chunk(row) if row else None

    # --- Helpers ---

    @staticmethod
    def _row_to_folder(row: sqlite3.Row) -> FolderRecord:
        keys = row.keys()
        failed_files = []
        if "failed_files" in keys and row["failed_files"]:
            try:
                data = json.loads(row["failed_files"])
                if isinstance(data, list):
                    failed_files = [FailedFile(**item) for item in data]
            except (json.JSONDecodeError, TypeError):
                pass

        scan_mode = "full"
        if "scan_mode" in keys and row["scan_mode"]:
            scan_mode = row["scan_mode"]
        
        privacy_level = "normal"
        if "privacy_level" in keys and row["privacy_level"]:
            privacy_level = row["privacy_level"]

        return FolderRecord(
            id=row["id"],
            path=Path(row["path"]),
            label=row["label"],
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            updated_at=dt.datetime.fromisoformat(row["updated_at"]),
            last_indexed_at=dt.datetime.fromisoformat(row["last_indexed_at"]) if row["last_indexed_at"] else None,
            enabled=bool(row["enabled"]),
            failed_files=failed_files,
            indexed_count=row["indexed_count"] if "indexed_count" in keys else 0,
            scan_mode=scan_mode,
            privacy_level=privacy_level,
        )

    @staticmethod
    def _row_to_file(row: sqlite3.Row) -> FileRecord:
        keys = row.keys()
        raw_status = row["index_status"] if "index_status" in keys else None
        error_reason = row["error_reason"] if "error_reason" in keys else None
        error_at = dt.datetime.fromisoformat(row["error_at"]) if "error_at" in keys and row["error_at"] else None
        
        has_embedding = row["embedding_vector"] is not None
        has_summary = row["summary"] is not None and row["summary"] != ""
        
        if raw_status == "error":
            index_status = "error"
        elif raw_status == "indexed":
            index_status = "indexed"
        elif raw_status == "pending":
            has_metadata = row["metadata"] is not None and row["metadata"] != "" and row["metadata"] != "{}"
            if has_embedding or has_summary or has_metadata:
                index_status = "indexed"
            else:
                index_status = "pending"
        else:
            if has_embedding or has_summary:
                index_status = "indexed"
            else:
                index_status = "pending"
        
        # Two-round indexing stage fields
        fast_stage = row["fast_stage"] if "fast_stage" in keys and row["fast_stage"] is not None else 0
        fast_text_at = dt.datetime.fromisoformat(row["fast_text_at"]) if "fast_text_at" in keys and row["fast_text_at"] else None
        fast_embed_at = dt.datetime.fromisoformat(row["fast_embed_at"]) if "fast_embed_at" in keys and row["fast_embed_at"] else None
        deep_stage = row["deep_stage"] if "deep_stage" in keys and row["deep_stage"] is not None else 0
        deep_text_at = dt.datetime.fromisoformat(row["deep_text_at"]) if "deep_text_at" in keys and row["deep_text_at"] else None
        deep_embed_at = dt.datetime.fromisoformat(row["deep_embed_at"]) if "deep_embed_at" in keys and row["deep_embed_at"] else None
        
        # Privacy level
        privacy_level = row["privacy_level"] if "privacy_level" in keys and row["privacy_level"] else "normal"
        
        return FileRecord(
            id=row["id"],
            folder_id=row["folder_id"],
            path=Path(row["path"]),
            name=row["name"],
            extension=row["extension"],
            size=int(row["size"]),
            modified_at=dt.datetime.fromisoformat(row["modified_at"]),
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            kind=row["kind"] if row["kind"] else "other",
            hash=row["hash"],
            summary=row["summary"],
            embedding_vector=FileMixin._deserialize_vector(row["embedding_vector"]),
            embedding_determined_at=dt.datetime.fromisoformat(row["embedding_determined_at"]) if row["embedding_determined_at"] else None,
            mime_type=row["mime_type"],
            checksum_sha256=row["checksum_sha256"],
            duration_seconds=row["duration_seconds"],
            page_count=row["page_count"],
            preview_image=row["preview_image"],
            metadata=FileMixin._deserialize_metadata(row["metadata"]),
            index_status=index_status,
            error_reason=error_reason,
            error_at=error_at,
            fast_stage=fast_stage,
            fast_text_at=fast_text_at,
            fast_embed_at=fast_embed_at,
            deep_stage=deep_stage,
            deep_text_at=deep_text_at,
            deep_embed_at=deep_embed_at,
            privacy_level=privacy_level,
        )

    @staticmethod
    def _row_to_chunk(row: sqlite3.Row) -> ChunkSnapshot:
        keys = row.keys()
        version = row["version"] if "version" in keys and row["version"] else "fast"
        privacy_level = row["privacy_level"] if "privacy_level" in keys and row["privacy_level"] else "normal"
        return ChunkSnapshot(
            chunk_id=row["id"],
            file_id=row["file_id"],
            ordinal=int(row["ordinal"]),
            text=row["text"],
            snippet=row["snippet"],
            token_count=int(row["token_count"]),
            char_count=int(row["char_count"]),
            section_path=row["section_path"],
            metadata=FileMixin._deserialize_metadata(row["metadata"]),
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            version=version,
            privacy_level=privacy_level,
        )

    @staticmethod
    def _serialize_vector(vector: Optional[list[float]]) -> Optional[bytes]:
        if vector is None:
            return None
        return ",".join(f"{value:.6f}" for value in vector).encode("ascii")

    @staticmethod
    def _deserialize_vector(blob: Optional[bytes]) -> Optional[list[float]]:
        if not blob:
            return None
        text = blob.decode("ascii")
        return [float(part) for part in text.split(",") if part]

    @staticmethod
    def _serialize_metadata(metadata: dict[str, Any] | None) -> Optional[str]:
        if not metadata:
            return None
        return json.dumps(metadata, ensure_ascii=False)

    @staticmethod
    def _deserialize_metadata(payload: Optional[str]) -> dict[str, Any]:
        if not payload:
            return {}
        try:
            data = json.loads(payload)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
        return {}
