"""
Configuration for MCP Server
"""

from __future__ import annotations

import os
import platform
from pathlib import Path


def _get_env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _get_env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _get_env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_default_data_dir() -> Path:
    """Get the default Local Cocoa data directory based on platform."""
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        return home / "Library" / "Application Support" / "Local Cocoa" / "local_rag"
    elif system == "Windows":
        appdata = os.getenv("APPDATA", str(home / "AppData" / "Roaming"))
        return Path(appdata) / "Local Cocoa" / "local_rag"
    else:
        return home / ".config" / "Local Cocoa" / "local_rag"


def _get_project_root() -> Path:
    """Get the project root directory."""
    # This file is at: plugins/mcp/backend/config.py
    return Path(__file__).parent.parent.parent.parent


def _get_dev_session_key_path() -> Path:
    """Get the path for dev session key file."""
    project_root = _get_project_root()
    return project_root / ".dev-session-key"


def get_api_key() -> str:
    """
    Get the API key for authenticating with the Local Cocoa backend.

    Priority:
    1. LOCAL_COCOA_API_KEY environment variable
    2. Dev session key file (.dev-session-key in project root) - for dev mode
    3. Legacy: Development path runtime/local_rag/local_key.txt (deprecated)
    4. Legacy: Production path system data directory (deprecated)
    
    Note: local_key.txt is deprecated. The backend now generates a session key
    on each startup and outputs it to stdout. In dev mode, it also writes to
    .dev-session-key for scripts to use.
    """
    # Check environment variable first
    env_key = os.getenv("LOCAL_COCOA_API_KEY")
    if env_key:
        return env_key

    # Try dev session key file (new pattern - matches auth.py DEV_SESSION_KEY_FILE)
    dev_session_key_path = _get_dev_session_key_path()
    if dev_session_key_path.exists():
        try:
            key = dev_session_key_path.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: file read errors are acceptable,
            # we'll fall back to other key sources below
            pass

    # Legacy: Try development path (runtime/local_rag/local_key.txt)
    project_root = _get_project_root()
    dev_key_file = project_root / "runtime" / "local_rag" / "local_key.txt"
    if dev_key_file.exists():
        try:
            key = dev_key_file.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: legacy file read errors are acceptable,
            # we'll fall back to production path or raise at the end
            pass

    # Legacy: Fall back to production path
    data_dir = get_default_data_dir()
    key_file = data_dir / "local_key.txt"

    if key_file.exists():
        try:
            key = key_file.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: file read errors here mean we'll raise
            # the ValueError below with a helpful message
            pass

    raise ValueError(
        "No API key found. Set LOCAL_COCOA_API_KEY environment variable "
        f"or ensure the Local Cocoa app is running (generates {dev_session_key_path} in dev mode)."
    )


def get_backend_url() -> str:
    """Get the backend URL for the Local Cocoa API."""
    return os.getenv("LOCAL_COCOA_BACKEND_URL", "http://127.0.0.1:8890")


def get_request_timeouts() -> dict[str, float]:
    """Get MCP client timeouts."""
    return {
        "connect": max(_get_env_float("LOCAL_COCOA_MCP_CONNECT_TIMEOUT", 2.0), 0.1),
        "read": max(_get_env_float("LOCAL_COCOA_MCP_READ_TIMEOUT", 15.0), 1.0),
        "qa": max(_get_env_float("LOCAL_COCOA_MCP_QA_TIMEOUT", 40.0), 5.0),
        "health": max(_get_env_float("LOCAL_COCOA_MCP_HEALTH_TIMEOUT", 2.0), 0.1),
    }


def get_retry_config() -> tuple[int, float]:
    """Get retry count and delay for transient connection errors."""
    retries = max(_get_env_int("LOCAL_COCOA_MCP_RETRIES", 1), 0)
    delay = max(_get_env_float("LOCAL_COCOA_MCP_RETRY_DELAY", 0.5), 0.0)
    return retries, delay


def get_max_response_chars() -> int:
    """Get the maximum characters allowed in MCP responses."""
    return max(_get_env_int("LOCAL_COCOA_MCP_MAX_RESPONSE_CHARS", 12000), 1000)


def get_max_file_chars() -> int:
    """Get the maximum characters allowed when returning full file content."""
    return max(_get_env_int("LOCAL_COCOA_MCP_MAX_FILE_CHARS", 20000), 2000)


def get_health_cache_ttl() -> float:
    """Get cache TTL for backend health checks."""
    return max(_get_env_float("LOCAL_COCOA_MCP_HEALTH_CACHE_TTL", 5.0), 0.0)


def get_search_multi_path_default() -> bool:
    """Default to multi-path search for MCP if enabled."""
    return _get_env_bool("LOCAL_COCOA_MCP_SEARCH_MULTIPATH", False)

