#!/usr/bin/env python3
"""
Entry point for running the MCP server directly.

Usage:
    python -m server

Or directly:
    python plugins/mcp/backend/__main__.py
"""

import asyncio
import sys

try:
    from .server import main
except ModuleNotFoundError as exc:
    print(
        "Missing dependencies for Local Cocoa MCP. Install with: pip install mcp httpx",
        file=sys.stderr,
    )
    raise exc

if __name__ == "__main__":
    asyncio.run(main())

