from fastapi import Security, HTTPException, status, Header
from fastapi.security.api_key import APIKeyHeader
from typing import Optional
from .config import settings
from services.core.context import get_storage
from .request_context import RequestContext, set_request_context, RequestSource
import secrets
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

API_KEY_NAME = "X-API-Key"
REQUEST_SOURCE_HEADER = "X-Request-Source"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# Dev mode: set LOCAL_COCOA_DEV_MODE=1 to enable easier API key access
DEV_MODE = os.getenv("LOCAL_COCOA_DEV_MODE", "0") == "1"

# Path for dev mode session key file (relative to project root)
DEV_SESSION_KEY_FILE = ".dev-session-key"


def get_dev_session_key_path() -> Path:
    """Get the path for dev session key file."""
    # Try to find project root by looking for package.json or .git
    current = Path(__file__).parent
    for _ in range(5):  # Go up max 5 levels
        if (current / "package.json").exists() or (current / ".git").exists():
            return current / DEV_SESSION_KEY_FILE
        current = current.parent
    # Fallback to temp directory
    return Path("/tmp") / DEV_SESSION_KEY_FILE


async def verify_api_key(
    api_key_header: str = Security(api_key_header),
    x_request_source: Optional[str] = Header(None, alias="X-Request-Source"),
):
    """
    Verify API key and set up request context with proper source identification.
    
    Request sources:
    - local_ui: Requests from Electron app (system key) - can access private files
    - external: External API requests - cannot access private files
    - mcp: MCP protocol requests (Claude Desktop etc.) - cannot access private files
    - plugin: Plugin requests - cannot access private files
    """
    # Dev mode bypass: if no key provided, try to read from dev session key file
    if not api_key_header and DEV_MODE:
        dev_key_path = get_dev_session_key_path()
        if dev_key_path.exists():
            try:
                api_key_header = dev_key_path.read_text().strip()
                logger.debug("Using dev session key from file")
            except Exception:
                pass
    
    if not api_key_header:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Missing API Key"
        )

    storage = get_storage()
    key_record = storage.get_api_key(api_key_header)

    if not key_record or not key_record.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or inactive API Key"
        )

    storage.update_api_key_usage(api_key_header)
    
    # Determine request source for privacy filtering
    # System keys (from Electron app) are treated as local_ui
    # External requests are identified by X-Request-Source header
    source: RequestSource = "external"
    
    if x_request_source:
        # Explicit source header provided
        if x_request_source == "mcp":
            source = "mcp"
        elif x_request_source == "plugin":
            source = "plugin"
        elif x_request_source == "local_ui" and key_record.is_system:
            # Only allow local_ui source for system keys (extra security)
            source = "local_ui"
        # For any other value, treat as external
    elif key_record.is_system:
        # System keys without explicit header are assumed to be from local UI
        source = "local_ui"
    
    # Set request context for privacy filtering throughout this request
    ctx = RequestContext(source=source, api_key=api_key_header)
    set_request_context(ctx)
    
    logger.debug(f"Request context set: source={source}, can_access_private={ctx.can_access_private}")
    
    return key_record


def ensure_local_key(base_dir: Path):
    storage = get_storage()
    # Always generate a new random session key on startup
    # We do NOT store this in the DB permanently or look for existing keys.
    # It is a one-time session key.

    # Check if a session key already exists in DB from previous run and delete it?
    # Actually, the user says "gen a one time password".
    # We will generate a new one, add it to DB (so verify_api_key works),
    # and print it to stdout.

    session_key = f"sk-session-{secrets.token_urlsafe(32)}"
    logger.info(f"Generating session key...")

    # Clean up old session keys if any?
    keys = storage.list_api_keys()
    for k in keys:
        if k.name == "session-key":
            storage.delete_api_key(k.key)

    storage.create_api_key(session_key, "session-key", is_system=True)

    # PRINT to stdout for the parent process (Electron) to capture
    # This acts as the secure transmission channel.
    print(f"SERVER_SESSION_TOKEN: {session_key}", flush=True)

    # In dev mode, also write to a file for easy access by scripts
    if DEV_MODE:
        dev_key_path = get_dev_session_key_path()
        try:
            dev_key_path.write_text(session_key)
            logger.info(f"Dev mode: Session key written to {dev_key_path}")
            print(f"DEV_SESSION_KEY_FILE: {dev_key_path}", flush=True)
        except Exception as e:
            logger.warning(f"Failed to write dev session key file: {e}")

    # Clean up old key file if it exists (legacy)
    key_file = base_dir / "local_key.txt"
    if key_file.exists():
        try:
            key_file.unlink()
        except OSError:
            pass

    return session_key
