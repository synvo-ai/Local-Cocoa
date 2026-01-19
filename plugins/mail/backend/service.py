from __future__ import annotations

import asyncio
import base64
import datetime as dt
import email
from email import policy
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
import imaplib
import logging
import poplib
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

from markdownify import markdownify
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError

from services.core.config import settings
from services.indexer import Indexer
from services.core.models import (
    EmailAccount,
    EmailAccountCreate,
    EmailAccountSummary,
    EmailMessageRecord,
    EmailMessageSummary,
    EmailMessageContent,
    EmailSyncRequest,
    EmailSyncResult,
    FolderRecord,
)
from services.storage import IndexStorage
from .outlook import (
    OUTLOOK_DEFAULT_CLIENT_ID,
    OUTLOOK_DEFAULT_TENANT_ID,
    OutlookService,
    OutlookAuthError,
    OutlookServiceError,
)

# Re-export for router
__all__ = [
    "EmailService",
    "EmailServiceError",
    "EmailSyncError",
    "EmailAuthError",
    "EmailAccountNotFound",
]

logger = logging.getLogger(__name__)

# Azure Identity's device-code flow legitimately receives 400 responses while waiting
# (e.g., "authorization_pending"). Keep the low-level HTTP logs quieter.
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)



# Use MSAL-friendly delegated scopes (do not include reserved values like offline_access).
# These must match what the Graph SDK/kiota auth provider requests, otherwise the token cache
# won't be hit and the app will keep prompting.
GRAPH_SCOPES: tuple[str, ...] = (
    "User.Read",
    "Mail.Read",
)


class EmailServiceError(Exception):
    """Base error for email service issues."""


class EmailSyncError(EmailServiceError):
    """Raised when a sync operation fails."""


class EmailAuthError(EmailSyncError):
    """Raised when syncing requires the user to re-authenticate."""


class EmailAccountNotFound(EmailServiceError):
    """Raised when an email account is missing."""


class EmailService:
    MAX_SYNC_BATCH = 100

    def __init__(self, storage: IndexStorage, indexer: Indexer) -> None:
        self.storage = storage
        self.indexer = indexer
        self._root = settings.base_dir / "mail"
        self._root.mkdir(parents=True, exist_ok=True)
        self._outlook_service = OutlookService()

    async def start_outlook_auth(self, client_id: str, tenant_id: str) -> str:
        client_id = (client_id or "").strip() or OUTLOOK_DEFAULT_CLIENT_ID
        tenant_id = (tenant_id or "").strip() or OUTLOOK_DEFAULT_TENANT_ID
        return await self._outlook_service.start_auth(client_id, tenant_id)

    async def get_outlook_auth_status(self, flow_id: str) -> dict:
        try:
            return await self._outlook_service.get_auth_status(flow_id)
        except OutlookServiceError as e:
            return {'status': 'error', 'message': str(e)}

    async def complete_outlook_setup(self, flow_id: str, label: str) -> EmailAccountSummary:
        try:
            details = await self._outlook_service.complete_auth(flow_id)
        except OutlookServiceError as e:
            raise EmailServiceError(str(e)) from e

        now = dt.datetime.now(dt.timezone.utc)
        account = EmailAccount(
            id=uuid.uuid4().hex,
            label=label,
            protocol="outlook",
            host="graph.microsoft.com",
            port=443,
            username=details["username"] or "outlook_user",
            secret="",
            use_ssl=True,
            folder="INBOX",
            enabled=True,
            created_at=now,
            updated_at=now,
            client_id=details["client_id"],
            tenant_id=details["tenant_id"]
        )

        self.storage.upsert_email_account(account)
        folder_path = self._ensure_account_folder(account)
        return self._to_summary(account, folder_path)

    def list_accounts(self) -> list[EmailAccountSummary]:
        summaries: list[EmailAccountSummary] = []
        accounts = self.storage.list_email_accounts()
        for account in accounts:
            removed = self.storage.prune_missing_email_messages(account.id)
            if removed:
                logger.info("Pruned %d orphaned email message records for %s", removed, account.label)
            folder_path = self._ensure_account_folder(account)
            summaries.append(self._to_summary(account, folder_path))
        return summaries

    def add_account(self, payload: EmailAccountCreate) -> EmailAccountSummary:
        payload_label = payload.label.strip()
        if not payload_label:
            raise EmailServiceError("Account label is required.")

        now = dt.datetime.now(dt.timezone.utc)
        account = EmailAccount(
            id=uuid.uuid4().hex,
            label=payload_label,
            protocol=payload.protocol,
            host=payload.host.strip(),
            port=self._resolve_port(payload.protocol, payload.port, payload.use_ssl),
            username=payload.username.strip(),
            secret=self._encode_secret(payload.password),
            use_ssl=payload.use_ssl,
            folder=payload.folder.strip() if payload.protocol == "imap" and payload.folder else None,
            enabled=True,
            created_at=now,
            updated_at=now,
            last_synced_at=None,
            last_sync_status=None,
        )

        for existing in self.storage.list_email_accounts():
            if existing.username == account.username and existing.host == account.host:
                raise EmailServiceError("An account with the same host and username already exists.")

        self.storage.upsert_email_account(account)
        folder_path = self._ensure_account_folder(account)
        return self._to_summary(account, folder_path)

    def remove_account(self, account_id: str) -> None:
        account = self.storage.get_email_account(account_id)
        if not account:
            raise EmailAccountNotFound("Email account not found.")
        folder_path = self._account_spool_path(account.id)
        folder_id = self._folder_id(account)

        # Remove vectors first
        try:
            self.indexer.vector_store.delete_by_filter(folder_id=folder_id)
        except Exception as exc:
            logger.warning("Failed to remove vectors for account %s: %s", account_id, exc)

        # Remove files from storage (files table)
        # This is important because files table has a foreign key to folders table
        # If we don't delete files first, we might violate FK constraints or leave orphaned records
        # if the FK isn't set to CASCADE (it is ON DELETE CASCADE in schema, but good to be explicit or rely on it)
        # The schema says: folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE
        # So deleting the folder should cascade to files.

        self.storage.delete_email_account(account_id)

        # Also remove the folder record from storage if it exists
        # This triggers the ON DELETE CASCADE for files and chunks
        if self.storage.get_folder(folder_id):
            self.storage.remove_folder(folder_id)

        if folder_path.exists():
            shutil.rmtree(folder_path, ignore_errors=True)

    async def sync_account(self, account_id: str, request: EmailSyncRequest) -> EmailSyncResult:
        account = self.storage.get_email_account(account_id)
        if not account:
            raise EmailAccountNotFound("Email account not found.")

        folder_path = self._ensure_account_folder(account)

        if account.protocol == "outlook":
            return await self._sync_outlook(account, request, folder_path)

        try:
            batch_limit = self._sanitize_limit(request.limit)
            result = await asyncio.to_thread(self._sync_account_blocking, account, batch_limit, folder_path)
        except EmailSyncError as exc:
            self.storage.update_email_account_sync(
                account.id, last_synced_at=dt.datetime.now(dt.timezone.utc), status=f"error: {exc}")
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected email sync failure for %s", account.id)
            self.storage.update_email_account_sync(
                account.id, last_synced_at=dt.datetime.now(dt.timezone.utc), status=f"error: {exc}")
            raise EmailSyncError("Unexpected failure while syncing account.") from exc

        if result.new_messages > 0:
            await self.indexer.refresh(folders=[result.folder_id])
            result.indexed = result.new_messages
        else:
            result.indexed = 0

        self.storage.update_email_account_sync(account.id, last_synced_at=result.last_synced_at, status=result.status)
        return result

    async def _sync_outlook(self, account: EmailAccount, request: EmailSyncRequest, folder_path: Path) -> EmailSyncResult:
        try:
            if not (account.client_id or "").strip():
                account.client_id = OUTLOOK_DEFAULT_CLIENT_ID
                self.storage.upsert_email_account(account)
            if not (account.tenant_id or "").strip():
                account.tenant_id = OUTLOOK_DEFAULT_TENANT_ID
                self.storage.upsert_email_account(account)

            logger.info(
                "Syncing Outlook account %s client_id=%s tenant_id=%s",
                account.id,
                account.client_id,
                account.tenant_id,
            )

            limit = self._sanitize_limit(request.limit)

            # Delegate to clean service
            try:
                # Pass username if available to help select the right account from cache
                messages = await self._outlook_service.fetch_messages(
                    client_id=account.client_id,
                    tenant_id=account.tenant_id,
                    limit=limit,
                    username=account.username if account.username and "@" in account.username else None
                )
            except OutlookAuthError as e:
                raise EmailAuthError(str(e)) from e
            except OutlookServiceError as e:
                raise EmailSyncError(str(e)) from e

            existing_ids = set(self.storage.list_email_message_ids(account.id))
            new_records = []

            for msg in messages:
                if msg.id in existing_ids:
                    continue

                # Extract basic fields
                subject = msg.subject or "(No Subject)"
                sender = "Unknown"
                if msg.from_ and msg.from_.email_address:
                    sender = f"{msg.from_.email_address.name or ''} <{msg.from_.email_address.address or ''}>".strip()

                date_val = msg.received_date_time

                recipients: list[str] = []
                if msg.to_recipients:
                    recipients.extend(
                        [r.email_address.address for r in msg.to_recipients if r.email_address]
                    )
                if msg.cc_recipients:
                    recipients.extend(
                        [r.email_address.address for r in msg.cc_recipients if r.email_address]
                    )

                # Process body content
                body_content = ""
                if msg.body and msg.body.content:
                    body_content = self._render_body_markdown(
                        msg.body.content,
                        getattr(msg.body, "content_type", None),
                    )
                elif msg.body_preview:
                    body_content = msg.body_preview

                body_content = body_content.strip() or "_No body content available._"

                # Save to file using the same markdown writer as IMAP
                ts = int(date_val.timestamp()) if date_val else int(dt.datetime.now().timestamp())
                safe_id = "".join(c for c in msg.id if c.isalnum())
                file_name = f"{ts}_{safe_id}.md"
                file_path = folder_path / file_name
                self._write_markdown(file_path, subject, sender, recipients, date_val, body_content)
                file_size = file_path.stat().st_size

                record = EmailMessageRecord(
                    id=uuid.uuid4().hex,
                    account_id=account.id,
                    external_id=msg.id,
                    subject=subject,
                    sender=sender,
                    recipients=recipients,
                    sent_at=date_val or dt.datetime.now(dt.timezone.utc),
                    stored_path=file_path,
                    size=file_size,
                    created_at=dt.datetime.now(dt.timezone.utc),
                )
                new_records.append(record)

            new_count = len(new_records)
            for record in new_records:
                self.storage.record_email_message(record)

            if new_count > 0:
                await self.indexer.refresh(folders=[self._folder_id(account)])

            total_messages = self.storage.count_email_messages(account.id)
            last_synced = dt.datetime.now(dt.timezone.utc)
            message = "No new messages." if new_count == 0 else f"Fetched {new_count} message{'s' if new_count != 1 else ''}."

            self.storage.update_email_account_sync(account.id, last_synced_at=last_synced, status="ok")

            return EmailSyncResult(
                account_id=account.id,
                folder_id=self._folder_id(account),
                folder_path=folder_path,
                new_messages=new_count,
                total_messages=total_messages,
                indexed=new_count,
                last_synced_at=last_synced,
                status="ok",
                message=message,
            )

        except EmailSyncError as exc:
            self.storage.update_email_account_sync(
                account.id,
                last_synced_at=dt.datetime.now(dt.timezone.utc),
                status=f"error: {exc}",
            )
            raise
        except (ClientAuthenticationError, HttpResponseError) as exc:
            logger.exception("Outlook sync auth failed")
            self.storage.update_email_account_sync(
                account.id,
                last_synced_at=dt.datetime.now(dt.timezone.utc),
                status=f"error: {exc}",
            )
            raise EmailAuthError(str(exc)) from exc
        except Exception as exc:
            logger.exception("Outlook sync failed")
            self.storage.update_email_account_sync(
                account.id,
                last_synced_at=dt.datetime.now(dt.timezone.utc),
                status=f"error: {exc}",
            )
            raise EmailSyncError(f"Outlook sync failed: {exc}") from exc

    def list_messages(self, account_id: str, limit: int) -> list[EmailMessageSummary]:
        account = self.storage.get_email_account(account_id)
        if not account:
            raise EmailAccountNotFound("Email account not found.")
        records = self.storage.list_email_messages(account_id, limit)
        summaries: list[EmailMessageSummary] = []
        for record in records:
            summary = self._record_to_summary(record)
            if summary:
                summaries.append(summary)
        return summaries

    def get_message(self, message_id: str) -> EmailMessageContent:
        record = self.storage.get_email_message(message_id)
        if not record:
            raise EmailServiceError("Email message not found.")
        markdown = self._read_markdown(record.stored_path)
        summary = self._record_to_summary(record)
        if not summary:
            raise EmailServiceError("Email file missing from disk.")
        return EmailMessageContent(**summary.model_dump(), markdown=markdown)

    def _sync_account_blocking(self, account: EmailAccount, limit: int, folder_path: Path) -> EmailSyncResult:
        secret = self._decode_secret(account.secret)
        existing_ids = set(self.storage.list_email_message_ids(account.id))
        if account.protocol == "imap":
            new_records = self._sync_imap(account, secret, folder_path, existing_ids, limit)
        elif account.protocol == "pop3":
            new_records = self._sync_pop3(account, secret, folder_path, existing_ids, limit)
        else:
            raise EmailSyncError(f"Unsupported protocol: {account.protocol}")

        new_count = len(new_records)
        for record in new_records:
            self.storage.record_email_message(record)

        removed = self.storage.prune_missing_email_messages(account.id)
        if removed:
            logger.info("Pruned %d orphaned email message records for %s", removed, account.label)
        total_messages = self.storage.count_email_messages(account.id)
        last_synced = dt.datetime.now(dt.timezone.utc)
        message = "No new messages." if new_count == 0 else f"Fetched {new_count} message{'s' if new_count != 1 else ''}."

        return EmailSyncResult(
            account_id=account.id,
            folder_id=self._folder_id(account),
            folder_path=folder_path,
            new_messages=new_count,
            total_messages=total_messages,
            indexed=0,
            last_synced_at=last_synced,
            status="ok",
            message=message,
        )

    def _sync_imap(
        self,
        account: EmailAccount,
        password: str,
        spool_path: Path,
        existing_ids: set[str],
        limit: int,
    ) -> list[EmailMessageRecord]:
        client: imaplib.IMAP4 | imaplib.IMAP4_SSL
        if account.use_ssl:
            client = imaplib.IMAP4_SSL(account.host, account.port)
        else:
            client = imaplib.IMAP4(account.host, account.port)

        try:
            client.login(account.username, password)
            mailbox = account.folder or "INBOX"
            status, _ = client.select(mailbox, readonly=True)
            if status != "OK":
                raise EmailSyncError(f"Unable to select mailbox '{mailbox}'.")

            status, data = client.uid("search", None, "ALL")
            if status != "OK" or not data:
                return []
            raw_ids = data[0]
            if not raw_ids:
                return []
            uid_values = [uid for uid in raw_ids.split() if uid]
            uid_values = uid_values[-limit:]

            new_records: list[EmailMessageRecord] = []
            for uid in uid_values:
                status, fetched = client.uid("fetch", uid, "(RFC822)")
                if status != "OK" or not fetched:
                    continue
                message_bytes = fetched[0][1]
                if not message_bytes:
                    continue
                record = self._build_message_record(
                    account,
                    message_bytes,
                    existing_ids,
                    spool_path,
                    external_identifier=uid.decode("ascii", errors="ignore"),
                )
                if record:
                    new_records.append(record)
                    existing_ids.add(record.external_id)
            return new_records
        except EmailSyncError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise EmailSyncError(str(exc)) from exc
        finally:
            try:
                client.logout()
            except Exception:  # noqa: BLE001
                pass

    def _sync_pop3(
        self,
        account: EmailAccount,
        password: str,
        spool_path: Path,
        existing_ids: set[str],
        limit: int,
    ) -> list[EmailMessageRecord]:
        server: poplib.POP3 | poplib.POP3_SSL
        if account.use_ssl:
            server = poplib.POP3_SSL(account.host, account.port, timeout=30)
        else:
            server = poplib.POP3(account.host, account.port, timeout=30)

        try:
            server.user(account.username)
            server.pass_(password)
            response, listings, _ = server.uidl()
            if not listings or b"+OK" not in response:
                return []
            entries = [entry.decode("utf-8", errors="ignore") for entry in listings]
            indexed_entries = []
            for line in entries:
                parts = line.split()
                if len(parts) >= 2:
                    indexed_entries.append((int(parts[0]), parts[1]))
            indexed_entries = indexed_entries[-limit:]

            new_records: list[EmailMessageRecord] = []
            for index, external_id in indexed_entries:
                if external_id in existing_ids:
                    continue
                resp, lines, _ = server.retr(index)
                if b"+OK" not in resp or not lines:
                    continue
                message_bytes = b"\r\n".join(lines) + b"\r\n"
                record = self._build_message_record(
                    account,
                    message_bytes,
                    existing_ids,
                    spool_path,
                    external_identifier=external_id,
                )
                if record:
                    new_records.append(record)
                    existing_ids.add(record.external_id)
            return new_records
        except EmailSyncError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise EmailSyncError(str(exc)) from exc
        finally:
            try:
                server.quit()
            except Exception:  # noqa: BLE001
                pass

    def _build_message_record(
        self,
        account: EmailAccount,
        message_bytes: bytes,
        existing_ids: set[str],
        spool_path: Path,
        *,
        external_identifier: str,
    ) -> Optional[EmailMessageRecord]:
        message = email.message_from_bytes(message_bytes, policy=policy.default)
        external_id = message.get("Message-ID") or external_identifier
        if external_id in existing_ids:
            return None

        body_text = self._extract_text(message)
        sent_at = self._parse_date(message.get("Date"))
        subject = message.get("Subject")
        sender = message.get("From")
        recipients = self._collect_recipients(message)

        timestamp = (sent_at or dt.datetime.now(dt.timezone.utc)).strftime("%Y%m%d-%H%M%S")
        slug = self._slugify(subject or "message")
        filename = f"{timestamp}-{slug}-{uuid.uuid4().hex[:8]}.md"
        target_path = spool_path / filename
        self._write_markdown(target_path, subject, sender, recipients, sent_at, body_text)

        return EmailMessageRecord(
            id=uuid.uuid4().hex,
            account_id=account.id,
            external_id=external_id,
            subject=subject,
            sender=sender,
            recipients=recipients,
            sent_at=sent_at,
            stored_path=target_path,
            size=len(message_bytes),
            created_at=dt.datetime.now(dt.timezone.utc),
        )

    def _ensure_account_folder(self, account: EmailAccount) -> Path:
        folder_path = self._account_spool_path(account.id)
        folder_path.mkdir(parents=True, exist_ok=True)

        existing = self.storage.get_folder(self._folder_id(account))
        now = dt.datetime.now(dt.timezone.utc)
        if existing:
            record = FolderRecord(
                id=existing.id,
                path=folder_path,
                label=existing.label,
                created_at=existing.created_at,
                updated_at=now,
                last_indexed_at=existing.last_indexed_at,
                enabled=True,
            )
        else:
            record = FolderRecord(
                id=self._folder_id(account),
                path=folder_path,
                label=f"Email · {account.label}",
                created_at=now,
                updated_at=now,
                last_indexed_at=None,
                enabled=True,
            )
        self.storage.upsert_folder(record)
        return folder_path

    def _to_summary(self, account: EmailAccount, folder_path: Path) -> EmailAccountSummary:
        window = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
        total_messages = self.storage.count_email_messages(account.id)
        recent_new = self.storage.count_email_messages_since(account.id, window)
        return EmailAccountSummary(
            id=account.id,
            label=account.label,
            protocol=account.protocol,
            host=account.host,
            port=account.port,
            username=account.username,
            use_ssl=account.use_ssl,
            folder=account.folder,
            enabled=account.enabled,
            created_at=account.created_at,
            updated_at=account.updated_at,
            last_synced_at=account.last_synced_at,
            last_sync_status=account.last_sync_status,
            total_messages=total_messages,
            recent_new_messages=recent_new,
            folder_id=self._folder_id(account),
            folder_path=folder_path,
        )

    def _account_spool_path(self, account_id: str) -> Path:
        return self._root / account_id

    @staticmethod
    def _resolve_port(protocol: str, port: int, use_ssl: bool) -> int:
        if port:
            return port
        if protocol == "imap":
            return 993 if use_ssl else 143
        if protocol == "pop3":
            return 995 if use_ssl else 110
        return port

    @staticmethod
    def _encode_secret(password: str) -> str:
        return base64.b64encode(password.encode("utf-8")).decode("ascii")

    @staticmethod
    def _decode_secret(secret: str) -> str:
        try:
            return base64.b64decode(secret.encode("ascii")).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            raise EmailServiceError("Stored credentials are corrupted.") from exc

    @staticmethod
    def _collect_recipients(message: EmailMessage) -> list[str]:
        fields = []
        for header in ("To", "Cc", "Bcc"):
            value = message.get(header)
            if value:
                fields.append(value)
        if not fields:
            return []
        addresses = getaddresses(fields)
        return [addr for _, addr in addresses if addr]

    @staticmethod
    def _parse_date(value: Optional[str]) -> Optional[dt.datetime]:
        if not value:
            return None
        try:
            parsed = parsedate_to_datetime(value)
            if parsed and parsed.tzinfo:
                return parsed.astimezone(dt.timezone.utc).replace(tzinfo=None)
            return parsed
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _extract_text(message: EmailMessage) -> str:
        if message.is_multipart():
            for part in message.walk():
                if part.get_content_maintype() == "multipart":
                    continue
                content_type = part.get_content_type()
                if content_type == "text/plain":
                    decoded = EmailService._decode_part(part)
                    if decoded:
                        return decoded
            for part in message.walk():
                if part.get_content_type() == "text/html":
                    html_text = EmailService._decode_part(part)
                    if html_text:
                        return EmailService._html_to_text(html_text)
            return ""
        content_type = message.get_content_type()
        payload = EmailService._decode_part(message)
        if content_type == "text/html":
            return EmailService._html_to_text(payload or "")
        return payload or ""

    @staticmethod
    def _decode_part(part: EmailMessage) -> str:
        try:
            payload = part.get_payload(decode=True)
            if payload is None:
                return ""
            charset = part.get_content_charset() or "utf-8"
            try:
                return payload.decode(charset, errors="replace")
            except LookupError:
                return payload.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return ""

    @staticmethod
    def _html_to_text(payload: str) -> str:
        text = re.sub(r"<br\s*/?>", "\n", payload, flags=re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    @staticmethod
    def _render_body_markdown(content: str, content_type: Any | None) -> str:
        if not content:
            return ""
        if EmailService._looks_like_html(content_type, content):
            return markdownify(
                content,
                heading_style="ATX",
                strip=["script", "style"],
            ).strip()
        return content

    @staticmethod
    def _looks_like_html(content_type: Any | None, content: str) -> bool:
        if content_type is not None:
            raw = getattr(content_type, "value", content_type)
            raw_str = str(raw)
            if "html" in raw_str.lower():
                return True
        return bool(re.search(r"<\w+[^>]*>", content))

    @staticmethod
    def _write_markdown(
        path: Path,
        subject: Optional[str],
        sender: Optional[str],
        recipients: Iterable[str],
        sent_at: Optional[dt.datetime],
        body_text: str,
    ) -> None:
        lines = [
            f"# {subject.strip() if subject else 'Untitled message'}",
            "",
            f"- From: {sender or 'Unknown sender'}",
            f"- To: {', '.join(recipients) if recipients else 'Unknown recipients'}",
            f"- Date: {sent_at.isoformat() if sent_at else 'Unknown'}",
            "",
            body_text.strip() or '_No body content available._',
        ]
        path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")

    @staticmethod
    def _slugify(value: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
        return cleaned or "message"

    def _folder_id(self, account: EmailAccount) -> str:
        return f"email::{account.id}"

    def _sanitize_limit(self, requested: int | None) -> int:
        if requested is None or requested <= 0:
            return self.MAX_SYNC_BATCH
        return max(1, min(requested, self.MAX_SYNC_BATCH))

    def _record_to_summary(self, record: EmailMessageRecord) -> EmailMessageSummary | None:
        if not record.stored_path.exists():
            return None
        preview = self._extract_preview(record.stored_path)
        return EmailMessageSummary(
            id=record.id,
            account_id=record.account_id,
            subject=record.subject,
            sender=record.sender,
            recipients=record.recipients,
            sent_at=record.sent_at,
            stored_path=record.stored_path,
            size=record.size,
            created_at=record.created_at,
            preview=preview,
        )

    @staticmethod
    def _read_markdown(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise EmailServiceError("Email content file missing.") from exc

    @staticmethod
    def _extract_preview(path: Path, lines: int = 6) -> str | None:
        try:
            content = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        snippet = [line for line in content.splitlines() if line.strip()][:lines]
        return "\n".join(snippet) if snippet else None
