"""
Request Context Management for Privacy Control

This module provides request-scoped context tracking to determine the source
of each request and enforce privacy policies accordingly.

Request Sources:
- local_ui: Requests from Local Cocoa's Electron UI (full access including private files)
- external: External API requests via API key (no private file access)
- mcp: MCP protocol requests from Claude Desktop, etc. (no private file access)
- plugin: Plugin requests (no private file access)

Usage:
    # In middleware/dependency:
    ctx = RequestContext(source="mcp")
    set_request_context(ctx)
    
    # In service code:
    ctx = get_request_context()
    if ctx.can_access_private:
        # Include private files
    else:
        # Filter out private files
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Literal, Optional

# Type aliases
RequestSource = Literal["local_ui", "external", "mcp", "plugin"]
PrivacyLevel = Literal["normal", "private"]


@dataclass
class RequestContext:
    """
    Request-scoped context for tracking request source and access permissions.
    
    Attributes:
        source: The origin of the request (local_ui, external, mcp, plugin)
        api_key: The API key used for authentication (if any)
        can_access_private: Whether this request can access private files
        request_id: Optional unique identifier for request tracing
    """
    source: RequestSource = "external"
    api_key: Optional[str] = None
    request_id: Optional[str] = None
    can_access_private: bool = field(init=False)
    
    def __post_init__(self) -> None:
        # Only local_ui requests can access private files
        # All other sources (external, mcp, plugin) are restricted
        self.can_access_private = (self.source == "local_ui")
    
    def can_access(self, privacy_level: PrivacyLevel) -> bool:
        """
        Check if this request context allows access to data with the given privacy level.
        
        Args:
            privacy_level: The privacy level of the data ("normal" or "private")
            
        Returns:
            True if access is allowed, False otherwise
        """
        if privacy_level == "normal":
            return True
        if privacy_level == "private":
            return self.can_access_private
        # Unknown privacy level - deny by default
        return False


# Global context variable for request-scoped storage
# Default to external (most restrictive) for safety
_request_context: ContextVar[RequestContext] = ContextVar(
    'request_context',
    default=RequestContext(source="external")
)


def get_request_context() -> RequestContext:
    """
    Get the current request context.
    
    Returns:
        The RequestContext for the current request, or a default external context
        if none has been set.
    """
    return _request_context.get()


def set_request_context(ctx: RequestContext) -> None:
    """
    Set the request context for the current request scope.
    
    Args:
        ctx: The RequestContext to set
    """
    _request_context.set(ctx)


def reset_request_context() -> None:
    """
    Reset the request context to the default (external) state.
    Useful for cleanup after request processing.
    """
    _request_context.set(RequestContext(source="external"))


# Convenience functions for common operations

def is_local_ui_request() -> bool:
    """Check if the current request is from the local UI."""
    return get_request_context().source == "local_ui"


def is_external_request() -> bool:
    """Check if the current request is from an external source (API, MCP, plugin)."""
    return get_request_context().source != "local_ui"


def current_source() -> RequestSource:
    """Get the source of the current request."""
    return get_request_context().source


def can_access_private_files() -> bool:
    """Check if the current request can access private files."""
    return get_request_context().can_access_private

