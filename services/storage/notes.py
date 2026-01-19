"""Note storage operations."""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path
from typing import Optional

from services.core.models import NoteRecord


class NoteMixin:
    """Mixin for handling notes."""

    def _ensure_note_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE notes ADD COLUMN {name} {definition}")

        add_column("title", "TEXT NOT NULL")
        add_column("path", "TEXT NOT NULL")
        add_column("created_at", "TEXT NOT NULL")
        add_column("updated_at", "TEXT NOT NULL")

    def upsert_note(self, record: NoteRecord) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO notes (id, title, path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    path=excluded.path,
                    updated_at=excluded.updated_at
                """,
                (
                    record.id,
                    record.title,
                    str(record.path),
                    record.created_at.isoformat(),
                    record.updated_at.isoformat(),
                ),
            )

    def list_notes(self) -> list[NoteRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM notes ORDER BY updated_at DESC"
            ).fetchall()
        return [self._row_to_note(row) for row in rows]

    def get_note(self, note_id: str) -> Optional[NoteRecord]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return self._row_to_note(row) if row else None

    def delete_note(self, note_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))

    @staticmethod
    def _row_to_note(row: sqlite3.Row) -> NoteRecord:
        return NoteRecord(
            id=row["id"],
            title=row["title"],
            path=Path(row["path"]),
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            updated_at=dt.datetime.fromisoformat(row["updated_at"]),
        )
