"""Email storage operations."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Optional

from services.core.models import EmailAccount, EmailMessageRecord


class EmailMixin:
    """Mixin for handling email accounts and messages."""

    def _ensure_email_columns(self, conn: sqlite3.Connection) -> None:
        accounts = {row["name"] for row in conn.execute("PRAGMA table_info(email_accounts)").fetchall()}
        messages = {row["name"] for row in conn.execute("PRAGMA table_info(email_messages)").fetchall()}

        def add_account_column(name: str, definition: str) -> None:
            if name not in accounts:
                conn.execute(f"ALTER TABLE email_accounts ADD COLUMN {name} {definition}")

        def add_message_column(name: str, definition: str) -> None:
            if name not in messages:
                conn.execute(f"ALTER TABLE email_messages ADD COLUMN {name} {definition}")

        add_account_column("last_synced_at", "TEXT")
        add_account_column("last_sync_status", "TEXT")
        add_account_column("enabled", "INTEGER NOT NULL DEFAULT 1")
        add_message_column("recipients", "TEXT")
        add_message_column("created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")
        
        # Migrations that were inline
        try:
            conn.execute("SELECT client_id FROM email_accounts LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE email_accounts ADD COLUMN client_id TEXT")
            conn.execute("ALTER TABLE email_accounts ADD COLUMN tenant_id TEXT")

    def list_email_accounts(self) -> list[EmailAccount]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT * FROM email_accounts ORDER BY created_at ASC",
            ).fetchall()
        return [self._row_to_email_account(row) for row in rows]

    def get_email_account(self, account_id: str) -> Optional[EmailAccount]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute("SELECT * FROM email_accounts WHERE id = ?", (account_id,)).fetchone()
        return self._row_to_email_account(row) if row else None

    def upsert_email_account(self, account: EmailAccount) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT INTO email_accounts (
                    id, label, protocol, host, port, username, secret, use_ssl, folder, enabled,
                    created_at, updated_at, last_synced_at, last_sync_status, client_id, tenant_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    label=excluded.label,
                    protocol=excluded.protocol,
                    host=excluded.host,
                    port=excluded.port,
                    username=excluded.username,
                    secret=excluded.secret,
                    use_ssl=excluded.use_ssl,
                    folder=excluded.folder,
                    enabled=excluded.enabled,
                    updated_at=excluded.updated_at,
                    last_synced_at=excluded.last_synced_at,
                    last_sync_status=excluded.last_sync_status,
                    client_id=excluded.client_id,
                    tenant_id=excluded.tenant_id
                """,
                (
                    account.id,
                    account.label,
                    account.protocol,
                    account.host,
                    account.port,
                    account.username,
                    account.secret,
                    1 if account.use_ssl else 0,
                    account.folder,
                    1 if account.enabled else 0,
                    account.created_at.isoformat(),
                    account.updated_at.isoformat(),
                    account.last_synced_at.isoformat() if account.last_synced_at else None,
                    account.last_sync_status,
                    account.client_id,
                    account.tenant_id,
                ),
            )

    def delete_email_account(self, account_id: str) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute("DELETE FROM email_accounts WHERE id = ?", (account_id,))

    def update_email_account_sync(self, account_id: str, *, last_synced_at: Optional[dt.datetime], status: Optional[str]) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                UPDATE email_accounts
                SET last_synced_at = ?, last_sync_status = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    last_synced_at.isoformat() if last_synced_at else None,
                    status,
                    dt.datetime.now(dt.timezone.utc).isoformat(),
                    account_id,
                ),
            )

    def list_email_message_ids(self, account_id: str) -> set[str]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                "SELECT external_id FROM email_messages WHERE account_id = ?",
                (account_id,),
            ).fetchall()
        return {str(row["external_id"]) for row in rows}

    def record_email_message(self, record: EmailMessageRecord) -> None:
        with self.connect() as conn:  # type: ignore
            conn.execute(
                """
                INSERT OR IGNORE INTO email_messages (
                    id, account_id, external_id, subject, sender, recipients, sent_at, stored_path, size, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.account_id,
                    record.external_id,
                    record.subject,
                    record.sender,
                    json.dumps(record.recipients, ensure_ascii=False),
                    record.sent_at.isoformat() if record.sent_at else None,
                    str(record.stored_path),
                    record.size,
                    record.created_at.isoformat(),
                ),
            )

    def list_email_messages(self, account_id: str, limit: int = 100) -> list[EmailMessageRecord]:
        with self.connect() as conn:  # type: ignore
            rows = conn.execute(
                """
                SELECT * FROM email_messages
                WHERE account_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (account_id, limit),
            ).fetchall()
        return [self._row_to_email_message(row) for row in rows]

    def get_email_message(self, message_id: str) -> Optional[EmailMessageRecord]:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                "SELECT * FROM email_messages WHERE id = ?",
                (message_id,),
            ).fetchone()
        return self._row_to_email_message(row) if row else None

    def count_email_messages(self, account_id: str) -> int:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                "SELECT COUNT(*) FROM email_messages WHERE account_id = ?",
                (account_id,),
            ).fetchone()
        return int(row[0] if row else 0)

    def count_email_messages_since(self, account_id: str, threshold: dt.datetime) -> int:
        with self.connect() as conn:  # type: ignore
            row = conn.execute(
                "SELECT COUNT(*) FROM email_messages WHERE account_id = ? AND created_at >= ?",
                (account_id, threshold.isoformat()),
            ).fetchone()
        return int(row[0] if row else 0)

    def prune_missing_email_messages(self, account_id: Optional[str] = None) -> int:
        removed = 0
        query = "SELECT id, stored_path FROM email_messages"
        params: tuple[object, ...] = ()
        if account_id:
            query += " WHERE account_id = ?"
            params = (account_id,)

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(query, params).fetchall()
            orphan_ids = [row["id"] for row in rows if not Path(row["stored_path"]).exists()]
            if orphan_ids:
                conn.executemany("DELETE FROM email_messages WHERE id = ?", ((identifier,) for identifier in orphan_ids))
                removed = len(orphan_ids)
        return removed

    @staticmethod
    def _row_to_email_account(row: sqlite3.Row) -> EmailAccount:
        return EmailAccount(
            id=row["id"],
            label=row["label"],
            protocol=row["protocol"],
            host=row["host"],
            port=int(row["port"]),
            username=row["username"],
            secret=row["secret"],
            use_ssl=bool(row["use_ssl"]),
            folder=row["folder"],
            enabled=bool(row["enabled"]),
            created_at=dt.datetime.fromisoformat(row["created_at"]),
            updated_at=dt.datetime.fromisoformat(row["updated_at"]),
            last_synced_at=dt.datetime.fromisoformat(row["last_synced_at"]) if row["last_synced_at"] else None,
            last_sync_status=row["last_sync_status"],
            client_id=row["client_id"] if "client_id" in row.keys() else None,
            tenant_id=row["tenant_id"] if "tenant_id" in row.keys() else None,
        )

    @staticmethod
    def _row_to_email_message(row: sqlite3.Row) -> EmailMessageRecord:
        recipients_payload = row["recipients"]
        recipients: list[str] = []
        if recipients_payload:
            try:
                data = json.loads(recipients_payload)
                if isinstance(data, list):
                    recipients = [str(item) for item in data]
            except json.JSONDecodeError:
                recipients = [str(recipients_payload)]
        return EmailMessageRecord(
            id=row["id"],
            account_id=row["account_id"],
            external_id=row["external_id"],
            subject=row["subject"],
            sender=row["sender"],
            recipients=recipients,
            sent_at=dt.datetime.fromisoformat(row["sent_at"]) if row["sent_at"] else None,
            stored_path=Path(row["stored_path"]),
            size=int(row["size"]),
            created_at=dt.datetime.fromisoformat(row["created_at"]),
        )
