"""
Privacy Policy Manager

Centralized privacy policy enforcement for Local Cocoa.
This module provides utilities for filtering data based on privacy levels
and request sources.

Key Principles:
1. Private files are ONLY accessible from local UI
2. External requests (API, MCP, plugins) can only see "normal" files
3. Privacy filtering happens at the earliest possible stage
4. Error responses must not leak information about private files
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Sequence, TypeVar

from fastapi import HTTPException, status

from .request_context import RequestContext, get_request_context

logger = logging.getLogger(__name__)

T = TypeVar("T")


class PrivacyManager:
    """
    Centralized privacy policy enforcement.
    
    This class provides static methods for:
    - Checking access permissions
    - Generating SQL filter conditions
    - Generating vector store filter conditions
    - Filtering result lists
    - Generating policy denial responses
    """
    
    # Standard response for privacy policy violations
    # Intentionally generic to avoid leaking information
    POLICY_DENIED_MESSAGE = "Access restricted by privacy policy"
    
    @staticmethod
    def can_access(privacy_level: str, ctx: Optional[RequestContext] = None) -> bool:
        """
        Check if the given privacy level is accessible in the current context.
        
        Args:
            privacy_level: The privacy level to check ("normal" or "private")
            ctx: Optional RequestContext (uses current context if not provided)
            
        Returns:
            True if access is allowed, False otherwise
        """
        if ctx is None:
            ctx = get_request_context()
        
        if privacy_level == "normal":
            return True
        if privacy_level == "private":
            return ctx.can_access_private
        # Unknown privacy level - default to normal (accessible)
        logger.warning(f"Unknown privacy level: {privacy_level}, treating as normal")
        return True
    
    @staticmethod
    def sql_filter_clause(ctx: Optional[RequestContext] = None, table_alias: str = "") -> str:
        """
        Generate SQL WHERE clause fragment for privacy filtering.
        
        Args:
            ctx: Optional RequestContext (uses current context if not provided)
            table_alias: Optional table alias prefix (e.g., "f." for "f.privacy_level")
            
        Returns:
            SQL clause string, or empty string if no filtering needed
        """
        if ctx is None:
            ctx = get_request_context()
        
        if ctx.can_access_private:
            return ""  # No filtering needed for local UI
        
        prefix = f"{table_alias}." if table_alias else ""
        return f"{prefix}privacy_level = 'normal'"
    
    @staticmethod
    def sql_filter_params(ctx: Optional[RequestContext] = None) -> list[str]:
        """
        Generate SQL parameters for privacy filtering.
        
        Returns:
            List of parameter values (empty if no filtering needed)
        """
        if ctx is None:
            ctx = get_request_context()
        
        if ctx.can_access_private:
            return []
        return ["normal"]
    
    @staticmethod
    def vector_filter(ctx: Optional[RequestContext] = None) -> Optional[dict[str, Any]]:
        """
        Generate Qdrant filter condition for privacy filtering.
        
        Args:
            ctx: Optional RequestContext (uses current context if not provided)
            
        Returns:
            Qdrant filter dict, or None if no filtering needed
        """
        if ctx is None:
            ctx = get_request_context()
        
        if ctx.can_access_private:
            return None  # No filtering needed for local UI
        
        # Qdrant filter for privacy_level = "normal"
        return {
            "must": [
                {
                    "key": "privacy_level",
                    "match": {"value": "normal"}
                }
            ]
        }
    
    @staticmethod
    def filter_results(
        results: Sequence[T],
        get_privacy_level: callable,
        ctx: Optional[RequestContext] = None
    ) -> list[T]:
        """
        Filter a list of results based on privacy levels.
        
        Args:
            results: Sequence of result objects
            get_privacy_level: Function to extract privacy_level from each result
            ctx: Optional RequestContext (uses current context if not provided)
            
        Returns:
            Filtered list containing only accessible results
        """
        if ctx is None:
            ctx = get_request_context()
        
        if ctx.can_access_private:
            return list(results)  # Return all for local UI
        
        return [r for r in results if get_privacy_level(r) == "normal"]
    
    @staticmethod
    def raise_policy_denied() -> None:
        """
        Raise a generic policy denial exception.
        
        The error message is intentionally generic to avoid leaking
        information about whether a private file exists.
        
        Raises:
            HTTPException: 403 Forbidden with generic message
        """
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=PrivacyManager.POLICY_DENIED_MESSAGE
        )
    
    @staticmethod
    def check_access_or_raise(privacy_level: str, ctx: Optional[RequestContext] = None) -> None:
        """
        Check access and raise exception if denied.
        
        Args:
            privacy_level: The privacy level to check
            ctx: Optional RequestContext
            
        Raises:
            HTTPException: If access is denied
        """
        if not PrivacyManager.can_access(privacy_level, ctx):
            PrivacyManager.raise_policy_denied()
    
    @staticmethod
    def safe_not_found() -> None:
        """
        Raise a generic "not found" response.
        
        Used when a private file is requested by an external source.
        Returns 404 instead of 403 to avoid confirming file existence.
        
        Raises:
            HTTPException: 404 Not Found
        """
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Resource not found"
        )


# Convenience functions for common operations

def privacy_sql_filter(table_alias: str = "") -> str:
    """Shorthand for PrivacyManager.sql_filter_clause()"""
    return PrivacyManager.sql_filter_clause(table_alias=table_alias)


def privacy_vector_filter() -> Optional[dict[str, Any]]:
    """Shorthand for PrivacyManager.vector_filter()"""
    return PrivacyManager.vector_filter()


def check_file_access(privacy_level: str) -> bool:
    """Shorthand for PrivacyManager.can_access()"""
    return PrivacyManager.can_access(privacy_level)

