"""Chat storage operations."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from typing import Optional

from services.core.models import ChatMessage, ChatSession, SearchHit


class ChatMixin:
    """Mixin for handling chat sessions and messages."""

    def _ensure_chat_columns(self, conn: sqlite3.Connection) -> None:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()}

        def add_column(name: str, definition: str) -> None:
            if name not in existing:
                conn.execute(f"ALTER TABLE chat_messages ADD COLUMN {name} {definition}")

        add_column("is_multi_path", "INTEGER")
        add_column("thinking_steps", "TEXT")

    def upsert_chat_session(self, session: ChatSession) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO chat_sessions (id, title, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    updated_at=excluded.updated_at
                """,
                (
                    session.id,
                    session.title,
                    session.created_at.isoformat(),
                    session.updated_at.isoformat(),
                ),
            )

    def get_chat_session(self, session_id: str) -> Optional[ChatSession]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None

            messages_rows = conn.execute(
                "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC",
                (session_id,),
            ).fetchall()

            messages = [self._row_to_chat_message(r) for r in messages_rows]

            return ChatSession(
                id=row["id"],
                title=row["title"],
                created_at=dt.datetime.fromisoformat(row["created_at"]),
                updated_at=dt.datetime.fromisoformat(row["updated_at"]),
                messages=messages,
            )

    def list_chat_sessions(self, limit: int = 100, offset: int = 0) -> list[ChatSession]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()

            sessions = []
            for row in rows:
                messages_rows = conn.execute(
                    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC",
                    (row["id"],),
                ).fetchall()
                messages = [self._row_to_chat_message(r) for r in messages_rows]

                sessions.append(ChatSession(
                    id=row["id"],
                    title=row["title"],
                    created_at=dt.datetime.fromisoformat(row["created_at"]),
                    updated_at=dt.datetime.fromisoformat(row["updated_at"]),
                    messages=messages,
                ))
            return sessions

    def delete_chat_session(self, session_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))

    def add_chat_message(self, message: ChatMessage) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO chat_messages (id, session_id, role, content, timestamp, meta, "references", is_multi_path, thinking_steps)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message.id,
                    message.session_id,
                    message.role,
                    message.content,
                    message.timestamp.isoformat(),
                    message.meta,
                    self._serialize_references(message.references),
                    1 if message.is_multi_path else (0 if message.is_multi_path is False else None),
                    self._serialize_thinking_steps(message.thinking_steps),
                ),
            )
            conn.execute(
                "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
                (message.timestamp.isoformat(), message.session_id),
            )

    @staticmethod
    def _row_to_chat_message(row: sqlite3.Row) -> ChatMessage:
        is_multi_path = None
        if "is_multi_path" in row.keys() and row["is_multi_path"] is not None:
            is_multi_path = bool(row["is_multi_path"])
        
        thinking_steps = None
        if "thinking_steps" in row.keys() and row["thinking_steps"]:
            thinking_steps = ChatMixin._deserialize_thinking_steps(row["thinking_steps"])
        
        return ChatMessage(
            id=row["id"],
            session_id=row["session_id"],
            role=row["role"],
            content=row["content"],
            timestamp=dt.datetime.fromisoformat(row["timestamp"]),
            meta=row["meta"],
            references=ChatMixin._deserialize_references(row["references"]),
            is_multi_path=is_multi_path,
            thinking_steps=thinking_steps,
        )

    @staticmethod
    def _serialize_references(refs: Optional[list[SearchHit]]) -> Optional[str]:
        if not refs:
            return None
        return json.dumps([ref.dict() for ref in refs], ensure_ascii=False)

    @staticmethod
    def _deserialize_references(payload: Optional[str]) -> Optional[list[SearchHit]]:
        if not payload:
            return None
        try:
            data = json.loads(payload)
            if isinstance(data, list):
                return [SearchHit(**item) for item in data]
        except (json.JSONDecodeError, TypeError):
            pass
        return None

    @staticmethod
    def _serialize_thinking_steps(steps: Optional[list[dict]]) -> Optional[str]:
        if not steps:
            return None
        return json.dumps(steps, ensure_ascii=False)

    @staticmethod
    def _deserialize_thinking_steps(payload: Optional[str]) -> Optional[list[dict]]:
        if not payload:
            return None
        try:
            data = json.loads(payload)
            if isinstance(data, list):
                return data
        except (json.JSONDecodeError, TypeError):
            pass
        return None
