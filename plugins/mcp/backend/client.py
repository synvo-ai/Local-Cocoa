"""
HTTP Client for Local Cocoa Backend API (Async version)
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .config import (
    get_api_key,
    get_backend_url,
    get_request_timeouts,
    get_retry_config,
)


class BackendError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class BackendUnavailable(BackendError):
    pass


class BackendTimeout(BackendError):
    pass


class BackendAuthError(BackendError):
    pass


class BackendRequestError(BackendError):
    pass


class LocalCocoaClient:
    """Async client for interacting with the Local Cocoa backend API."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = base_url or get_backend_url()
        self.api_key = ""
        self.api_key_error: str | None = None
        try:
            self.api_key = api_key or get_api_key()
        except Exception as exc:  # noqa: BLE001
            self.api_key_error = str(exc)
        self._client: httpx.AsyncClient | None = None
        self._timeouts = get_request_timeouts()
        self._max_retries, self._retry_delay = get_retry_config()

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=self._build_headers(),
                timeout=self._build_timeout()
            )
        return self._client

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            # CRITICAL: Mark all MCP requests as external source
            # This ensures privacy filtering is applied - MCP cannot access private files
            "X-Request-Source": "mcp",
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers

    def _build_timeout(self, read_timeout: float | None = None) -> httpx.Timeout:
        read_value = read_timeout if read_timeout is not None else self._timeouts["read"]
        return httpx.Timeout(read_value, connect=self._timeouts["connect"])

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        *,
        timeout: float | None = None,
        **kwargs
    ) -> httpx.Response:
        """Make a request with retry logic for transient connection failures."""
        last_error: Exception | None = None
        for attempt in range(max(self._max_retries, 1)):
            try:
                request_timeout = self._build_timeout(timeout)
                if method == "GET":
                    resp = await self.client.get(url, timeout=request_timeout, **kwargs)
                elif method == "POST":
                    resp = await self.client.post(url, timeout=request_timeout, **kwargs)
                elif method == "PUT":
                    resp = await self.client.put(url, timeout=request_timeout, **kwargs)
                elif method == "DELETE":
                    resp = await self.client.delete(url, timeout=request_timeout, **kwargs)
                else:
                    raise ValueError(f"Unknown method: {method}")
                resp.raise_for_status()
                return resp
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                last_error = exc
                if attempt < self._max_retries - 1:
                    await asyncio.sleep(self._retry_delay)
                    if self._client:
                        await self._client.aclose()
                        self._client = None
                continue
            except httpx.ReadTimeout as exc:
                raise BackendTimeout("Backend request timed out.") from exc
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in (401, 403):
                    raise BackendAuthError("Backend rejected the API key.", status_code=status) from exc
                detail = ""
                try:
                    detail = exc.response.text.strip()
                except Exception:
                    detail = ""
                if status >= 500:
                    message = f"Backend error (HTTP {status})."
                    if detail:
                        message = f"{message} {detail[:200]}"
                    raise BackendUnavailable(message, status_code=status) from exc
                message = f"Backend request failed (HTTP {status})."
                if detail:
                    message = f"{message} {detail[:200]}"
                raise BackendRequestError(message, status_code=status) from exc
            except httpx.HTTPError as exc:
                raise BackendUnavailable("Backend request failed.") from exc
        raise BackendUnavailable("Backend is unreachable.") from last_error

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def probe(self) -> tuple[str, float | None]:
        """Quickly check whether the backend is reachable."""
        started = time.monotonic()
        try:
            resp = await self.client.get(
                "/health",
                timeout=self._build_timeout(self._timeouts["health"]),
            )
        except (httpx.ConnectError, httpx.ConnectTimeout):
            return "unreachable", None
        except httpx.ReadTimeout:
            return "timeout", None
        except httpx.HTTPError:
            return "error", None

        latency_ms = (time.monotonic() - started) * 1000.0
        if resp.status_code == 403:
            return "unauthorized", latency_ms
        if 200 <= resp.status_code < 300:
            return "ok", latency_ms
        return "error", latency_ms

    # Health
    async def health(self) -> dict[str, Any]:
        """Check backend health status."""
        resp = await self._request_with_retry("GET", "/health", timeout=self._timeouts["health"])
        return resp.json()

    # Search
    async def search(self, query: str, limit: int = 10, multi_path: bool = True) -> dict[str, Any]:
        """
        Perform semantic search across indexed files.

        Args:
            query: The search query
            limit: Maximum number of results (1-20)
            multi_path: Enable multi-path retrieval for complex queries
        """
        resp = await self._request_with_retry(
            "GET", "/search",
            params={"q": query, "limit": limit, "multi_path": multi_path}
        )
        return resp.json()

    async def get_suggestions(self, limit: int = 4) -> list[str]:
        """Get suggested questions based on indexed content."""
        resp = await self._request_with_retry("GET", "/suggestions", params={"limit": limit})
        return resp.json()

    # Q&A
    async def qa(self, question: str, context_limit: int = 5) -> dict[str, Any]:
        """
        Ask a question and get an answer based on indexed documents.

        Args:
            question: The question to answer
            context_limit: Number of context documents to use
        """
        resp = await self._request_with_retry(
            "POST", "/qa",
            json={"query": question, "limit": context_limit},
            timeout=self._timeouts["qa"],
        )
        return resp.json()

    # Files
    async def list_files(self, limit: int = 100, offset: int = 0, folder_id: str | None = None) -> dict[str, Any]:
        """
        List indexed files.

        Args:
            limit: Maximum number of files to return (1-500)
            offset: Pagination offset
            folder_id: Optional folder ID to filter by
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if folder_id:
            params["folder_id"] = folder_id
        resp = await self._request_with_retry("GET", "/files", params=params)
        return resp.json()

    async def get_file(self, file_id: str) -> dict[str, Any]:
        """Get details of a specific file."""
        resp = await self._request_with_retry("GET", f"/files/{file_id}")
        return resp.json()

    async def get_file_chunks(self, file_id: str) -> list[dict[str, Any]]:
        """Get all text chunks for a file."""
        resp = await self._request_with_retry("GET", f"/files/{file_id}/chunks")
        return resp.json()

    async def get_chunk(self, chunk_id: str) -> dict[str, Any]:
        """Get a specific chunk by ID."""
        resp = await self._request_with_retry("GET", f"/files/chunks/{chunk_id}")
        return resp.json()

    # Folders
    async def list_folders(self) -> dict[str, Any]:
        """List all monitored folders."""
        resp = await self._request_with_retry("GET", "/folders")
        return resp.json()

    async def get_folder(self, folder_id: str) -> dict[str, Any]:
        """Get details of a specific folder."""
        resp = await self._request_with_retry("GET", f"/folders/{folder_id}")
        return resp.json()

    async def get_folder_files(self, folder_id: str) -> dict[str, Any]:
        """Get all files in a folder."""
        resp = await self._request_with_retry("GET", f"/folders/{folder_id}/files")
        return resp.json()

    # Notes
    async def list_notes(self) -> list[dict[str, Any]]:
        """List all notes."""
        resp = await self._request_with_retry("GET", "/notes")
        return resp.json()

    async def get_note(self, note_id: str) -> dict[str, Any]:
        """Get a specific note by ID."""
        resp = await self._request_with_retry("GET", f"/notes/{note_id}")
        return resp.json()

    async def create_note(self, title: str, content: str) -> dict[str, Any]:
        """Create a new note."""
        resp = await self._request_with_retry(
            "POST", "/notes",
            json={"title": title, "body": content}
        )
        return resp.json()

    async def update_note(self, note_id: str, title: str, content: str) -> dict[str, Any]:
        """Update an existing note."""
        resp = await self._request_with_retry(
            "PUT", f"/notes/{note_id}",
            json={"title": title, "body": content}
        )
        return resp.json()

    async def delete_note(self, note_id: str) -> None:
        """Delete a note."""
        await self._request_with_retry("DELETE", f"/notes/{note_id}")

    # Index
    async def get_index_status(self) -> dict[str, Any]:
        """Get current indexing status."""
        resp = await self._request_with_retry("GET", "/index/status")
        return resp.json()

    async def get_index_summary(self) -> dict[str, Any]:
        """Get summary of indexed content."""
        resp = await self._request_with_retry("GET", "/index/summary")
        return resp.json()

    async def trigger_index(self, folders: list[str] | None = None) -> dict[str, Any]:
        """Trigger indexing for specified folders or all."""
        payload: dict[str, Any] = {}
        if folders:
            payload["folders"] = folders
        resp = await self._request_with_retry("POST", "/index/run", json=payload)
        return resp.json()


# Global client instance
_client: LocalCocoaClient | None = None


def get_client() -> LocalCocoaClient:
    """Get or create the global client instance."""
    global _client
    if _client is None:
        _client = LocalCocoaClient()
    else:
        if not _client.api_key:
            try:
                _client.api_key = get_api_key()
                _client.api_key_error = None
                if _client._client:
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(_client._client.aclose())
                    except RuntimeError:
                        # No running event loop - this is expected when called from sync context
                        # The client will be recreated on next use, so safe to ignore
                        pass
                    _client._client = None
            except Exception as exc:
                # Failed to get API key - record the error for callers to check
                _client.api_key_error = str(exc)
    return _client

