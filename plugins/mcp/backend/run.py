#!/usr/bin/env python3
"""
Standalone script to run the Local Cocoa MCP Server.

Usage (from project root):
    # Method 1: Run as package (recommended)
    python -m backend
    # or from plugins/mcp directory:
    cd plugins/mcp && python -m backend
    
    # Method 2: Run this script directly
    python plugins/mcp/backend/run.py

Before running, make sure:
1. Local Cocoa backend is running (the main app)
2. Install dependencies: pip install mcp httpx
3. Set environment variables if needed (or let it auto-detect from .dev-session-key)
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path so we can import as a package
# This handles the case when running this script directly
script_dir = Path(__file__).parent
mcp_dir = script_dir.parent
if str(mcp_dir) not in sys.path:
    sys.path.insert(0, str(mcp_dir))

from backend.server import main


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nMCP server stopped.", file=sys.stderr)
        sys.exit(0)

