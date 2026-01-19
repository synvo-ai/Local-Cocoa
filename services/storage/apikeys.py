"""API Key storage operations."""

from __future__ import annotations

import datetime as dt
from typing import Optional

from services.core.models import ApiKey


class ApiKeyMixin:
    """Mixin for handling API keys."""

    def create_api_key(self, key: str, name: str, is_system: bool = False) -> ApiKey:
        now = dt.datetime.now(dt.timezone.utc)
        record = ApiKey(
            key=key,
            name=name,
            created_at=now,
            is_active=True,
            is_system=is_system,
        )
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO api_keys (key, name, created_at, is_active, is_system)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    record.key,
                    record.name,
                    record.created_at.isoformat(),
                    1 if record.is_active else 0,
                    1 if record.is_system else 0,
                ),
            )
        return record

    def get_api_key(self, key: str) -> Optional[ApiKey]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM api_keys WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        return ApiKey(
            key=row["key"],
            name=row["name"],
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            last_used_at=dt.datetime.fromisoformat(row["last_used_at"]) if row["last_used_at"] else None,
            is_active=bool(row["is_active"]),
            is_system=bool(row["is_system"]),
        )

    def list_api_keys(self) -> list[ApiKey]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute("SELECT * FROM api_keys ORDER BY created_at DESC").fetchall()
        return [
            ApiKey(
                key=row["key"],
                name=row["name"],
                created_at=dt.datetime.fromisoformat(row["created_at"]),
                last_used_at=dt.datetime.fromisoformat(row["last_used_at"]) if row["last_used_at"] else None,
                is_active=bool(row["is_active"]),
                is_system=bool(row["is_system"]),
            )
            for row in rows
        ]

    def delete_api_key(self, key: str) -> bool:
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute("DELETE FROM api_keys WHERE key = ?", (key,))
            return cursor.rowcount > 0

    def update_api_key_usage(self, key: str) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        with self.connect() as conn:  # type: ignore
            conn.execute(
                "UPDATE api_keys SET last_used_at = ? WHERE key = ?",
                (now.isoformat(), key),
            )

    def set_api_key_active(self, key: str, is_active: bool) -> bool:
        """Enable or disable an API key without deleting it."""
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(
                "UPDATE api_keys SET is_active = ? WHERE key = ?",
                (1 if is_active else 0, key),
            )
            return cursor.rowcount > 0

    def rename_api_key(self, key: str, new_name: str) -> bool:
        """Rename an API key."""
        with self.connect() as conn:  # type: ignore
            cursor = conn.execute(
                "UPDATE api_keys SET name = ? WHERE key = ?",
                (new_name, key),
            )
            return cursor.rowcount > 0
