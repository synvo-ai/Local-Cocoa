"""Base storage class handling connection and schema orchestration."""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

logger = logging.getLogger(__name__)

_SQLITE_PRAGMAS = (
    "PRAGMA journal_mode=WAL;",
    "PRAGMA synchronous=NORMAL;",
    "PRAGMA temp_store=MEMORY;",
    "PRAGMA foreign_keys=ON;",
    # OPTIMIZATION: Improve write performance during bulk indexing
    # Increase cache size from default ~2MB to 64MB for better I/O batching
    "PRAGMA cache_size=-64000;",  # Negative = KB, -64000 = 64MB
    # Use memory-mapped I/O for faster reads (256MB mmap)
    "PRAGMA mmap_size=268435456;",
    # Set busy timeout to reduce lock contention errors
    "PRAGMA busy_timeout=5000;",  # 5 seconds
)


class StorageBase:
    """Base class for IndexStorage providing database connection and schema setup."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._ensure_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        try:
            for pragma in _SQLITE_PRAGMAS:
                conn.execute(pragma)
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self.connect() as conn:
            # We execute the full schema script here to ensure all tables exist.
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS folders (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    label TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_indexed_at TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS api_keys (
                    key TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    is_system INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY,
                    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                    path TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    extension TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    modified_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    summary TEXT,
                    embedding_vector BLOB,
                    embedding_determined_at TEXT,
                    mime_type TEXT,
                    checksum_sha256 TEXT,
                    duration_seconds REAL,
                    page_count INTEGER,
                    preview_image BLOB,
                    metadata TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
                CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
                CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);

                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    snippet TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    char_count INTEGER NOT NULL,
                    section_path TEXT,
                    metadata TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
                CREATE INDEX IF NOT EXISTS idx_chunks_section ON chunks(section_path);

                -- FTS5 virtual table for efficient full-text search on chunks
                -- Uses BM25 ranking algorithm for relevance scoring
                -- This is a standalone FTS5 table (not content-linked) for simplicity
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    text,
                    snippet,
                    tokenize='porter unicode61'
                );

                -- Trigger to keep FTS5 in sync when chunks are inserted
                CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
                    INSERT INTO chunks_fts(rowid, text, snippet)
                    VALUES (NEW.rowid, NEW.text, NEW.snippet);
                END;

                -- Trigger to keep FTS5 in sync when chunks are updated
                CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
                    DELETE FROM chunks_fts WHERE rowid = OLD.rowid;
                    INSERT INTO chunks_fts(rowid, text, snippet)
                    VALUES (NEW.rowid, NEW.text, NEW.snippet);
                END;

                -- Trigger to keep FTS5 in sync when chunks are deleted
                CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
                    DELETE FROM chunks_fts WHERE rowid = OLD.rowid;
                END;

                CREATE TABLE IF NOT EXISTS email_accounts (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    secret TEXT NOT NULL,
                    use_ssl INTEGER NOT NULL DEFAULT 1,
                    folder TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_synced_at TEXT,
                    last_sync_status TEXT,
                    client_id TEXT,
                    tenant_id TEXT
                );

                CREATE TABLE IF NOT EXISTS email_messages (
                    id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
                    external_id TEXT NOT NULL,
                    subject TEXT,
                    sender TEXT,
                    recipients TEXT,
                    sent_at TEXT,
                    stored_path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(account_id, external_id)
                );

                CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id);
                CREATE INDEX IF NOT EXISTS idx_email_messages_created ON email_messages(created_at);

                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);

                CREATE TABLE IF NOT EXISTS activity_logs (
                    id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    description TEXT NOT NULL,
                    short_description TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs(timestamp);

                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    meta TEXT,
                    "references" TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
                CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
                """
            )
            
            if hasattr(self, "_ensure_file_columns"):
                self._ensure_file_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_chunk_columns"):
                self._ensure_chunk_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_email_columns"):
                self._ensure_email_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_note_columns"):
                self._ensure_note_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_activity_columns"):
                self._ensure_activity_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_folder_columns"):
                self._ensure_folder_columns(conn)  # type: ignore
            if hasattr(self, "_ensure_chat_columns"):
                self._ensure_chat_columns(conn)  # type: ignore
            
            # Privacy columns migration
            self._ensure_privacy_columns(conn)
    
    def _ensure_privacy_columns(self, conn: sqlite3.Connection) -> None:
        """Add privacy_level columns to folders, files, and chunks tables."""
        # Add privacy_level to folders table
        try:
            conn.execute("SELECT privacy_level FROM folders LIMIT 1")
        except sqlite3.OperationalError:
            logger.info("Adding privacy_level column to folders table")
            conn.execute("ALTER TABLE folders ADD COLUMN privacy_level TEXT DEFAULT 'normal'")
        
        # Add privacy_level to files table
        try:
            conn.execute("SELECT privacy_level FROM files LIMIT 1")
        except sqlite3.OperationalError:
            logger.info("Adding privacy_level column to files table")
            conn.execute("ALTER TABLE files ADD COLUMN privacy_level TEXT DEFAULT 'normal'")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_files_privacy ON files(privacy_level)")
        
        # Add privacy_level to chunks table
        try:
            conn.execute("SELECT privacy_level FROM chunks LIMIT 1")
        except sqlite3.OperationalError:
            logger.info("Adding privacy_level column to chunks table")
            conn.execute("ALTER TABLE chunks ADD COLUMN privacy_level TEXT DEFAULT 'normal'")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_privacy ON chunks(privacy_level)")