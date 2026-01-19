"""Activity log storage operations."""

from __future__ import annotations

import datetime as dt
import sqlite3
from typing import Any, Optional

from services.core.models import ActivityLog


class ActivityMixin:
    """Mixin for handling activity logs."""

    def _ensure_activity_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(activity_logs)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE activity_logs ADD COLUMN {name} {definition}")

        add_column("short_description", "TEXT")

    def insert_activity_log(self, record: ActivityLog) -> None:
        # self.connect() comes from StorageBase
        with self.connect() as conn:  # type: ignore
            conn.execute(
                "INSERT INTO activity_logs (id, timestamp, description, short_description) VALUES (?, ?, ?, ?)",
                (record.id, record.timestamp.isoformat(), record.description, record.short_description),
            )

    def list_activity_logs(self, start: Optional[dt.datetime] = None, end: Optional[dt.datetime] = None, limit: int = 1000) -> list[ActivityLog]:
        query = "SELECT * FROM activity_logs"
        params: list[Any] = []
        conditions: list[str] = []

        if start:
            conditions.append("timestamp >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("timestamp <= ?")
            params.append(end.isoformat())

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        query += " ORDER BY timestamp ASC LIMIT ?"
        params.append(limit)

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()

        return [
            ActivityLog(
                id=row["id"],
                timestamp=dt.datetime.fromisoformat(row["timestamp"]),
                description=row["description"],
                short_description=row["short_description"] if "short_description" in row.keys() else None
            )
            for row in rows
        ]

    def delete_activity_logs(self, start: Optional[dt.datetime] = None, end: Optional[dt.datetime] = None) -> int:
        query = "DELETE FROM activity_logs"
        params: list[Any] = []
        conditions: list[str] = []

        if start:
            conditions.append("timestamp >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("timestamp <= ?")
            params.append(end.isoformat())

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(query, params)
            deleted_count = cursor.rowcount

        return deleted_count

    def delete_activity_log(self, log_id: str) -> bool:
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute("DELETE FROM activity_logs WHERE id = ?", (log_id,))
            deleted_count = cursor.rowcount
        return deleted_count > 0
