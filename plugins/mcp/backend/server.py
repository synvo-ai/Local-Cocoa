#!/usr/bin/env python3
"""
Local Cocoa MCP Server

This server exposes Local Cocoa's capabilities through the Model Context Protocol,
allowing Claude Desktop to:
- Search indexed files semantically
- Ask questions about documents (RAG)
- Manage notes
- Browse indexed files and folders
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    Resource,
    ResourceTemplate,
)

from .client import (
    BackendAuthError,
    BackendError,
    BackendRequestError,
    BackendTimeout,
    BackendUnavailable,
    LocalCocoaClient,
    get_client,
)
from .config import (
    get_health_cache_ttl,
    get_max_file_chars,
    get_max_response_chars,
    get_search_multi_path_default,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger("mcp_server")

# Create the MCP server
server = Server("local-cocoa")

MAX_RESPONSE_CHARS = get_max_response_chars()
MAX_FILE_CHARS = get_max_file_chars()
HEALTH_CACHE_TTL = get_health_cache_ttl()
SEARCH_MULTIPATH_DEFAULT = get_search_multi_path_default()
_health_cache: dict[str, Any] = {"checked_at": 0.0, "status": "unknown", "message": ""}


def _truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    if max_chars < 50:
        return text[:max_chars]
    return text[: max_chars - 18] + "\n...[truncated]..."


def _limit_response(text: str) -> str:
    return _truncate_text(text, MAX_RESPONSE_CHARS)


def _collect_chunks_text(chunks: list[dict[str, Any]], max_chars: int) -> tuple[str, bool]:
    parts: list[str] = []
    total = 0
    truncated = False
    for chunk in chunks:
        chunk_text = chunk.get("text", "") or ""
        if not chunk_text:
            continue
        remaining = max_chars - total
        if remaining <= 0:
            truncated = True
            break
        if len(chunk_text) > remaining:
            parts.append(chunk_text[:remaining])
            truncated = True
            break
        parts.append(chunk_text)
        total += len(chunk_text) + 2
    return "\n\n".join(parts), truncated


def _text_content(text: str, max_chars: int | None = None) -> list[TextContent]:
    limit = MAX_RESPONSE_CHARS if max_chars is None else max_chars
    return [TextContent(type="text", text=_truncate_text(text, limit))]


def _format_backend_error(error: Exception) -> str:
    if isinstance(error, BackendAuthError):
        return (
            "Local Cocoa API key is missing or invalid. Open Local Cocoa once to generate a key, "
            "or set LOCAL_COCOA_API_KEY in the MCP environment."
        )
    if isinstance(error, BackendTimeout):
        return "Local Cocoa backend timed out. Try again, or reduce the request scope."
    if isinstance(error, BackendUnavailable):
        return "Local Cocoa backend is unavailable. Make sure the Local Cocoa app is running."
    if isinstance(error, BackendRequestError):
        return f"Local Cocoa backend rejected the request: {error}"
    return f"Unexpected error: {error}"


async def _ensure_backend_ready(client: LocalCocoaClient) -> str | None:
    if not client.api_key:
        if client.api_key_error:
            return (
                "Local Cocoa API key not found. Open Local Cocoa once to generate a key, "
                "or set LOCAL_COCOA_API_KEY in the MCP environment."
            )
        return (
            "Local Cocoa API key is empty. Open Local Cocoa to regenerate the key, "
            "or update LOCAL_COCOA_API_KEY in the MCP environment."
        )

    if HEALTH_CACHE_TTL > 0:
        age = time.monotonic() - _health_cache["checked_at"]
        if age < HEALTH_CACHE_TTL:
            cached_status = _health_cache.get("status")
            if cached_status == "ok":
                return None
            return _health_cache.get("message") or "Local Cocoa backend is unavailable."

    status, _latency = await client.probe()
    message: str | None = None
    if status == "ok":
        message = None
    elif status == "unauthorized":
        message = (
            "Local Cocoa API key is invalid. Open Local Cocoa to refresh the key, "
            "or update LOCAL_COCOA_API_KEY in the MCP environment."
        )
    elif status == "timeout":
        message = "Local Cocoa backend health check timed out."
    elif status == "unreachable":
        message = "Local Cocoa backend is not running."
    else:
        message = "Local Cocoa backend returned an unexpected response."

    _health_cache["checked_at"] = time.monotonic()
    _health_cache["status"] = "ok" if message is None else "error"
    _health_cache["message"] = message
    return message


def format_search_results(results: dict[str, Any]) -> str:
    """Format search results into readable text."""
    hits = results.get("hits", [])
    if not hits:
        return "No results found."

    lines = [f"Found {len(hits)} results:\n"]
    for i, hit in enumerate(hits, 1):
        file_info = hit.get("file", {})
        name = file_info.get("name", "Unknown")
        path = file_info.get("path", "")
        score = hit.get("score", 0)
        snippet = hit.get("snippet", "")

        lines.append(f"{i}. **{name}** (score: {score:.2f})")
        lines.append(f"   Path: {path}")
        if snippet:
            # Truncate long snippets
            snippet_preview = snippet[:500] + "..." if len(snippet) > 500 else snippet
            lines.append(f"   Preview: {snippet_preview}")
        lines.append("")

    return "\n".join(lines)


def format_files_list(data: dict[str, Any]) -> str:
    """Format file list into readable text."""
    files = data.get("files", [])
    total = data.get("total", len(files))

    if not files:
        return "No indexed files found."

    lines = [f"Showing {len(files)} of {total} indexed files:\n"]
    for f in files:
        name = f.get("name", "Unknown")
        path = f.get("path", "")
        kind = f.get("kind", "unknown")
        size = f.get("size_bytes", f.get("size", 0))
        summary = f.get("summary", "")

        size_str = _format_size(size)
        lines.append(f"- **{name}** ({kind}, {size_str})")
        lines.append(f"  Path: {path}")
        if summary:
            summary_preview = summary[:200] + "..." if len(summary) > 200 else summary
            lines.append(f"  Summary: {summary_preview}")
        lines.append("")

    return "\n".join(lines)


def format_folders_list(data: dict[str, Any]) -> str:
    """Format folder list into readable text."""
    folders = data.get("folders", [])

    if not folders:
        return "No monitored folders found."

    lines = ["Monitored folders:\n"]
    for f in folders:
        label = f.get("label", "")
        path = f.get("path", "")
        enabled = f.get("enabled", False)
        file_count = f.get("file_count", f.get("indexed_count", 0))
        status = "✓ enabled" if enabled else "✗ disabled"

        lines.append(f"- **{label}** ({status})")
        lines.append(f"  Path: {path}")
        lines.append(f"  Files: {file_count}")
        lines.append("")

    return "\n".join(lines)


def format_notes_list(notes: list[dict[str, Any]]) -> str:
    """Format notes list into readable text."""
    if not notes:
        return "No notes found."

    lines = [f"Found {len(notes)} notes:\n"]
    for note in notes:
        note_id = note.get("id", "")
        title = note.get("title", "Untitled")
        updated = note.get("updated_at", "")

        lines.append(f"- **{title}** (id: {note_id})")
        if updated:
            lines.append(f"  Updated: {updated}")
        lines.append("")

    return "\n".join(lines)


def format_qa_response(data: dict[str, Any]) -> str:
    """Format Q&A response into readable text."""
    answer = data.get("answer", "")
    sources = data.get("sources") or data.get("hits") or []

    lines = ["**Answer:**\n", answer, ""]

    if sources:
        lines.append("\n**Sources:**")
        for i, src in enumerate(sources, 1):
            file_info = src.get("file") or src.get("metadata") or {}
            name = (
                file_info.get("name")
                or file_info.get("file_name")
                or file_info.get("title")
                or "Unknown"
            )
            path = (
                file_info.get("path")
                or file_info.get("file_path")
                or file_info.get("full_path")
                or ""
            )
            fallback_id = src.get("file_id") or src.get("fileId") or ""
            lines.append(f"{i}. {name}")
            if path:
                lines.append(f"   {path}")
            elif fallback_id:
                lines.append(f"   file_id: {fallback_id}")

    return "\n".join(lines)


def format_index_status(data: dict[str, Any]) -> str:
    """Format index status into readable text."""
    status = data.get("status", "unknown")
    processed = data.get("processed", 0)
    failed = data.get("failed", 0)
    total = data.get("total")
    message = data.get("message", "")

    lines = [f"**Indexing Status:** {status}"]
    if total is not None:
        lines.append(f"Progress: {processed}/{total} files")
    else:
        lines.append(f"Processed: {processed} files")
    if failed > 0:
        lines.append(f"Failed: {failed} files")
    if message:
        lines.append(f"Message: {message}")

    return "\n".join(lines)


def _format_size(size_bytes: int) -> str:
    """Format bytes into human-readable size."""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


# Local Cocoa branding for MCP responses
LOCAL_COCOA_BRAND = "🍫 Local Cocoa"
LOCAL_COCOA_PREFIX = f"[{LOCAL_COCOA_BRAND}]"

# Instruction for Claude to attribute information to Local Cocoa
ATTRIBUTION_INSTRUCTION = (
    "IMPORTANT: When presenting results from this tool to the user, "
    "always mention that the information comes from Local Cocoa (their personal knowledge base). "
    "For example: 'According to Local Cocoa...' or 'Based on your Local Cocoa documents...'."
)


def _add_brand_prefix(text: str, action: str = "") -> str:
    """Add Local Cocoa branding to MCP response."""
    if action:
        return f"{LOCAL_COCOA_PREFIX} {action}\n\n{text}"
    return f"{LOCAL_COCOA_PREFIX}\n\n{text}"


def _tool_description(desc: str, include_attribution: bool = True) -> str:
    """Build tool description with optional attribution instruction."""
    if include_attribution:
        return f"{desc} {ATTRIBUTION_INSTRUCTION}"
    return desc


# =============================================================================
# Tool Definitions
# =============================================================================

@server.list_tools()
async def list_tools() -> list[Tool]:
    """List all available tools."""
    return [
        Tool(
            name="localcocoa_search",
            description=_tool_description(
                "Search the user's personal knowledge base in Local Cocoa. "
                "Performs semantic search across all indexed local files and returns relevant documents."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (1-20)",
                        "default": 10,
                        "minimum": 1,
                        "maximum": 20
                    },
                    "multi_path": {
                        "type": "boolean",
                        "description": "Enable multi-path retrieval for complex queries (slower but broader)",
                        "default": False
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="localcocoa_ask",
            description=_tool_description(
                "Ask a question about the user's indexed documents in Local Cocoa. "
                "Uses RAG to find relevant context and generate an answer from their personal knowledge base."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask"
                    },
                    "context_limit": {
                        "type": "integer",
                        "description": "Number of source documents to use for context (1-10)",
                        "default": 5,
                        "minimum": 1,
                        "maximum": 10
                    }
                },
                "required": ["question"]
            }
        ),
        Tool(
            name="localcocoa_list_files",
            description=_tool_description(
                "List all indexed files in the user's Local Cocoa knowledge base. Can optionally filter by folder."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of files to return (1-100)",
                        "default": 50,
                        "minimum": 1,
                        "maximum": 100
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Pagination offset",
                        "default": 0,
                        "minimum": 0
                    },
                    "folder_id": {
                        "type": "string",
                        "description": "Optional folder ID to filter files"
                    }
                }
            }
        ),
        Tool(
            name="localcocoa_get_file",
            description=_tool_description(
                "Get detailed information about a specific file indexed in Local Cocoa, including its summary and metadata."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_id": {
                        "type": "string",
                        "description": "The file ID"
                    }
                },
                "required": ["file_id"]
            }
        ),
        Tool(
            name="localcocoa_get_file_content",
            description=_tool_description(
                "Get the full text content of a file indexed in Local Cocoa by retrieving all its chunks."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_id": {
                        "type": "string",
                        "description": "The file ID"
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Maximum characters to return (truncates large files)",
                        "default": 20000,
                        "minimum": 1000,
                        "maximum": 200000
                    }
                },
                "required": ["file_id"]
            }
        ),
        Tool(
            name="localcocoa_list_folders",
            description=_tool_description(
                "List all monitored folders in the user's Local Cocoa setup."
            ),
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="localcocoa_list_notes",
            description=_tool_description(
                "List all notes stored in the user's Local Cocoa knowledge base."
            ),
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="localcocoa_get_note",
            description=_tool_description(
                "Get the full content of a specific note from Local Cocoa."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The note ID"
                    }
                },
                "required": ["note_id"]
            }
        ),
        Tool(
            name="localcocoa_create_note",
            description=_tool_description(
                "Create a new note in the user's Local Cocoa knowledge base.",
                include_attribution=False
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The note title"
                    },
                    "content": {
                        "type": "string",
                        "description": "The note content (markdown supported)"
                    }
                },
                "required": ["title", "content"]
            }
        ),
        Tool(
            name="localcocoa_update_note",
            description=_tool_description(
                "Update an existing note in the user's Local Cocoa knowledge base.",
                include_attribution=False
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The note ID to update"
                    },
                    "title": {
                        "type": "string",
                        "description": "The new note title"
                    },
                    "content": {
                        "type": "string",
                        "description": "The new note content"
                    }
                },
                "required": ["note_id", "title", "content"]
            }
        ),
        Tool(
            name="localcocoa_delete_note",
            description=_tool_description(
                "Delete a note from the user's Local Cocoa knowledge base.",
                include_attribution=False
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The note ID to delete"
                    }
                },
                "required": ["note_id"]
            }
        ),
        Tool(
            name="localcocoa_index_status",
            description=_tool_description(
                "Get the current indexing status of Local Cocoa.",
                include_attribution=False
            ),
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="localcocoa_index_summary",
            description=_tool_description(
                "Get a summary of all indexed content in Local Cocoa (total files, size, folders).",
                include_attribution=False
            ),
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="localcocoa_get_suggestions",
            description=_tool_description(
                "Get suggested questions based on the user's indexed content in Local Cocoa."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Number of suggestions (1-10)",
                        "default": 4,
                        "minimum": 1,
                        "maximum": 10
                    }
                }
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""
    try:
        client = get_client()
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to initialize MCP client: %s", exc)
        return _text_content(_format_backend_error(exc))

    preflight = await _ensure_backend_ready(client)
    if preflight:
        return _text_content(preflight)

    try:
        if name == "localcocoa_search":
            query = arguments.get("query", "")
            if not str(query).strip():
                return _text_content("Query cannot be empty.")
            limit = arguments.get("limit", 10)
            multi_path = arguments.get("multi_path", SEARCH_MULTIPATH_DEFAULT)
            results = await client.search(query, limit=limit, multi_path=multi_path)
            formatted = format_search_results(results)
            return _text_content(_limit_response(_add_brand_prefix(formatted, "Search Results")))

        if name == "localcocoa_ask":
            question = arguments.get("question", "")
            if not str(question).strip():
                return _text_content("Question cannot be empty.")
            context_limit = arguments.get("context_limit", 5)
            try:
                response = await client.qa(question, context_limit=context_limit)
                formatted = format_qa_response(response)
                return _text_content(_limit_response(_add_brand_prefix(formatted, "Answer")))
            except BackendTimeout:
                try:
                    fallback = await client.search(question, limit=min(max(context_limit, 3), 10), multi_path=False)
                    text = (
                        "Answer generation timed out. Here are the most relevant search results instead:\n\n"
                        + format_search_results(fallback)
                    )
                    return _text_content(_limit_response(_add_brand_prefix(text, "Fallback")))
                except BackendError as exc:
                    return _text_content(_format_backend_error(exc))

        if name == "localcocoa_list_files":
            limit = arguments.get("limit", 50)
            offset = arguments.get("offset", 0)
            folder_id = arguments.get("folder_id")
            data = await client.list_files(limit=limit, offset=offset, folder_id=folder_id)
            formatted = format_files_list(data)
            return _text_content(_limit_response(_add_brand_prefix(formatted, "Indexed Files")))

        if name == "localcocoa_get_file":
            file_id = arguments.get("file_id", "")
            data = await client.get_file(file_id)
            formatted = json.dumps(data, indent=2, default=str)
            return _text_content(_add_brand_prefix(formatted, "File Details"))

        if name == "localcocoa_get_file_content":
            file_id = arguments.get("file_id", "")
            try:
                requested_chars = int(arguments.get("max_chars", MAX_FILE_CHARS))
            except (TypeError, ValueError):
                requested_chars = MAX_FILE_CHARS
            max_chars = max(1000, min(requested_chars, MAX_FILE_CHARS))
            chunks = await client.get_file_chunks(file_id)
            full_text, truncated = _collect_chunks_text(chunks, max_chars)
            file_info = await client.get_file(file_id)
            file_name = file_info.get("name", "Unknown")
            if truncated:
                full_text += "\n\n...[truncated]..."
            content = f"# Content of: {file_name}\n\n{full_text}"
            return _text_content(_add_brand_prefix(content, "File Content"), max_chars=max_chars)

        if name == "localcocoa_list_folders":
            data = await client.list_folders()
            formatted = format_folders_list(data)
            return _text_content(_limit_response(_add_brand_prefix(formatted, "Monitored Folders")))

        if name == "localcocoa_list_notes":
            notes = await client.list_notes()
            formatted = format_notes_list(notes)
            return _text_content(_limit_response(_add_brand_prefix(formatted, "Notes")))

        if name == "localcocoa_get_note":
            note_id = arguments.get("note_id", "")
            note = await client.get_note(note_id)
            title = note.get("title", "Untitled")
            content = note.get("markdown", "")
            formatted = f"# {title}\n\n{content}"
            return _text_content(_add_brand_prefix(formatted, "Note"))

        if name == "localcocoa_create_note":
            title = arguments.get("title", "")
            content = arguments.get("content", "")
            note = await client.create_note(title, content)
            result = f"Note created successfully!\nID: {note.get('id')}\nTitle: {note.get('title')}"
            return _text_content(_add_brand_prefix(result, "Note Created"))

        if name == "localcocoa_update_note":
            note_id = arguments.get("note_id", "")
            title = arguments.get("title", "")
            content = arguments.get("content", "")
            note = await client.update_note(note_id, title, content)
            result = f"Note updated successfully!\nTitle: {note.get('title')}"
            return _text_content(_add_brand_prefix(result, "Note Updated"))

        if name == "localcocoa_delete_note":
            note_id = arguments.get("note_id", "")
            await client.delete_note(note_id)
            result = f"Note {note_id} deleted successfully."
            return _text_content(_add_brand_prefix(result, "Note Deleted"))

        if name == "localcocoa_index_status":
            data = await client.get_index_status()
            formatted = format_index_status(data)
            return _text_content(_limit_response(_add_brand_prefix(formatted, "Index Status")))

        if name == "localcocoa_index_summary":
            data = await client.get_index_summary()
            files = data.get("files_indexed", 0)
            folders = data.get("folders_indexed", 0)
            size = _format_size(data.get("total_size_bytes", 0))
            last_completed = data.get("last_completed_at", "Never")
            summary = (
                f"**Index Summary:**\n"
                f"- Files indexed: {files}\n"
                f"- Folders monitored: {folders}\n"
                f"- Total size: {size}\n"
                f"- Last indexed: {last_completed}"
            )
            return _text_content(_add_brand_prefix(summary, "Index Summary"))

        if name == "localcocoa_get_suggestions":
            limit = arguments.get("limit", 4)
            suggestions = await client.get_suggestions(limit=limit)
            if not suggestions:
                return _text_content(_add_brand_prefix("No suggestions available yet.", "Suggestions"))
            lines = ["**Suggested questions based on your content:**\n"]
            for i, q in enumerate(suggestions, 1):
                lines.append(f"{i}. {q}")
            return _text_content(_add_brand_prefix("\n".join(lines), "Suggestions"))

        return _text_content(f"Unknown tool: {name}")

    except BackendError as exc:
        logger.error("Error calling tool %s: %s", name, exc)
        return _text_content(_format_backend_error(exc))
    except Exception as exc:  # noqa: BLE001
        logger.error("Error calling tool %s: %s", name, exc)
        return _text_content(f"Error: {exc}")


# =============================================================================
# Resource Definitions
# =============================================================================

@server.list_resources()
async def list_resources() -> list[Resource]:
    """List available resources."""
    return [
        Resource(
            uri="localcocoa://index/summary",
            name="Index Summary",
            description="Summary of all indexed content in Local Cocoa",
            mimeType="application/json"
        ),
        Resource(
            uri="localcocoa://index/status",
            name="Index Status",
            description="Current indexing status",
            mimeType="application/json"
        ),
        Resource(
            uri="localcocoa://folders",
            name="Monitored Folders",
            description="List of all monitored folders",
            mimeType="application/json"
        ),
        Resource(
            uri="localcocoa://notes",
            name="Notes",
            description="List of all notes",
            mimeType="application/json"
        )
    ]


@server.list_resource_templates()
async def list_resource_templates() -> list[ResourceTemplate]:
    """List available resource templates."""
    return [
        ResourceTemplate(
            uriTemplate="localcocoa://files/{file_id}",
            name="File Details",
            description="Get details of a specific indexed file",
            mimeType="application/json"
        ),
        ResourceTemplate(
            uriTemplate="localcocoa://files/{file_id}/content",
            name="File Content",
            description="Get the full text content of a file",
            mimeType="text/plain"
        ),
        ResourceTemplate(
            uriTemplate="localcocoa://folders/{folder_id}",
            name="Folder Details",
            description="Get details of a specific folder",
            mimeType="application/json"
        ),
        ResourceTemplate(
            uriTemplate="localcocoa://notes/{note_id}",
            name="Note Content",
            description="Get the content of a specific note",
            mimeType="text/markdown"
        )
    ]


@server.read_resource()
async def read_resource(uri: str) -> str:
    """Read a resource by URI."""
    try:
        client = get_client()
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to initialize MCP client: %s", exc)
        return _format_backend_error(exc)

    preflight = await _ensure_backend_ready(client)
    if preflight:
        return preflight

    try:
        # Static resources
        if uri == "localcocoa://index/summary":
            data = await client.get_index_summary()
            return _limit_response(json.dumps(data, indent=2, default=str))

        if uri == "localcocoa://index/status":
            data = await client.get_index_status()
            return _limit_response(json.dumps(data, indent=2, default=str))

        if uri == "localcocoa://folders":
            data = await client.list_folders()
            return _limit_response(json.dumps(data, indent=2, default=str))

        if uri == "localcocoa://notes":
            data = await client.list_notes()
            return _limit_response(json.dumps(data, indent=2, default=str))

        # Template resources
        if uri.startswith("localcocoa://files/"):
            parts = uri.replace("localcocoa://files/", "").split("/")
            file_id = parts[0]

            if len(parts) > 1 and parts[1] == "content":
                chunks = await client.get_file_chunks(file_id)
                full_text, truncated = _collect_chunks_text(chunks, MAX_FILE_CHARS)
                if truncated:
                    full_text += "\n\n...[truncated]..."
                return _truncate_text(full_text, MAX_FILE_CHARS)
            data = await client.get_file(file_id)
            return _limit_response(json.dumps(data, indent=2, default=str))

        if uri.startswith("localcocoa://folders/"):
            folder_id = uri.replace("localcocoa://folders/", "")
            data = await client.get_folder(folder_id)
            return _limit_response(json.dumps(data, indent=2, default=str))

        if uri.startswith("localcocoa://notes/"):
            note_id = uri.replace("localcocoa://notes/", "")
            note = await client.get_note(note_id)
            return _limit_response(
                f"# {note.get('title', 'Untitled')}\n\n{note.get('markdown', '')}"
            )

        return f"Unknown resource: {uri}"

    except BackendError as exc:
        logger.error("Error reading resource %s: %s", uri, exc)
        return _format_backend_error(exc)
    except Exception as exc:  # noqa: BLE001
        logger.error("Error reading resource %s: %s", uri, exc)
        return f"Error: {exc}"


# =============================================================================
# Main Entry Point
# =============================================================================

async def main():
    """Run the MCP server."""
    import sys
    print("Starting Local Cocoa MCP Server...", file=sys.stderr)

    # Run the server with stdio transport (no blocking health check at startup)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())

