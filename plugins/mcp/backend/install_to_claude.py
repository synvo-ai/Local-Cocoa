#!/usr/bin/env python3
"""
Install Local Cocoa MCP to Claude Desktop configuration.

Usage:
    python install_to_claude.py

Or from project root:
    .venv/bin/python plugins/mcp/backend/install_to_claude.py

This script will:
1. Generate the MCP server configuration
2. Add it to Claude Desktop's config file
3. Print the configuration for manual installation if needed
"""

import json
import os
import platform
from pathlib import Path


def get_project_root() -> Path:
    """Get the Local Cocoa project root directory."""
    # This script is at: plugins/mcp/backend/install_to_claude.py
    return Path(__file__).parent.parent.parent.parent


def get_claude_config_path() -> Path:
    """Get the Claude Desktop config file path."""
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    elif system == "Windows":
        appdata = os.getenv("APPDATA", str(home / "AppData" / "Roaming"))
        return Path(appdata) / "Claude" / "claude_desktop_config.json"
    else:
        return home / ".config" / "Claude" / "claude_desktop_config.json"


def get_data_dir() -> Path:
    """Get the Local Cocoa data directory."""
    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        return home / "Library" / "Application Support" / "Local Cocoa" / "local_rag"
    elif system == "Windows":
        appdata = os.getenv("APPDATA", str(home / "AppData" / "Roaming"))
        return Path(appdata) / "local-cocoa" / "local_rag"
    else:
        return home / ".config" / "local-cocoa" / "local_rag"


def get_dev_session_key_path() -> Path:
    """Get the path for dev session key file."""
    return get_project_root() / ".dev-session-key"


def get_api_key() -> str:
    """
    Read API key for MCP authentication.
    
    Priority:
    1. LOCAL_COCOA_API_KEY environment variable
    2. Dev session key file (.dev-session-key in project root)
    3. Legacy: runtime/local_rag/local_key.txt (deprecated)
    4. Legacy: Production data directory (deprecated)
    """
    # Check environment variable first
    env_key = os.getenv("LOCAL_COCOA_API_KEY")
    if env_key:
        return env_key
    
    # Try dev session key file (new pattern)
    project_root = get_project_root()
    dev_session_key_path = project_root / ".dev-session-key"
    if dev_session_key_path.exists():
        try:
            key = dev_session_key_path.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: file read errors are acceptable,
            # we'll fall back to legacy key file locations below
            pass

    # Legacy: Try development path (runtime/local_rag/)
    dev_key_file = project_root / "runtime" / "local_rag" / "local_key.txt"
    if dev_key_file.exists():
        try:
            key = dev_key_file.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: legacy file read errors are acceptable,
            # we'll try production path next
            pass

    # Legacy: Fall back to production path
    data_dir = get_data_dir()
    key_file = data_dir / "local_key.txt"
    if key_file.exists():
        try:
            key = key_file.read_text().strip()
            if key:
                return key
        except Exception:
            # Intentionally ignored: if all key sources fail,
            # we return empty string and let caller handle it
            pass

    return ""


def get_python_path() -> str:
    """Find Python executable in the project's environment."""
    project_root = get_project_root()

    # Check for conda/venv environment (both use .venv/bin/python on Unix)
    env_paths = [
        project_root / ".venv" / "bin" / "python",          # macOS/Linux conda or venv
        project_root / ".venv" / "bin" / "python3",         # alternative
        project_root / ".venv" / "Scripts" / "python.exe",  # Windows conda or venv
        project_root / "venv" / "bin" / "python",           # alternative venv name
        project_root / "venv" / "Scripts" / "python.exe",
    ]

    for env_path in env_paths:
        if env_path.exists():
            return str(env_path)

    # Fallback to system Python
    if platform.system() == "Windows":
        return "python"
    return "python3"


def generate_config() -> dict:
    """Generate MCP configuration for Claude Desktop."""
    project_root = get_project_root()
    python_path = get_python_path()
    api_key = get_api_key()
    # Run from plugins/mcp so that "backend" is treated as a package
    # This allows relative imports (from .client import ...) to work correctly
    mcp_plugin_dir = project_root / "plugins" / "mcp"

    return {
        "local-cocoa": {
            "command": python_path,
            "args": ["-m", "backend"],
            "cwd": str(mcp_plugin_dir),
            "env": {
                "LOCAL_COCOA_API_KEY": api_key,
                "LOCAL_COCOA_BACKEND_URL": "http://127.0.0.1:8890",
                "PYTHONPATH": str(mcp_plugin_dir),
                "PYTHONUNBUFFERED": "1"
            }
        }
    }


def install_config():
    """Install MCP config to Claude Desktop."""
    config_path = get_claude_config_path()
    mcp_config = generate_config()

    print(f"Claude Desktop config path: {config_path}")
    print()

    # Ensure directory exists
    config_path.parent.mkdir(parents=True, exist_ok=True)

    # Read existing config or create new
    existing_config = {}
    if config_path.exists():
        try:
            existing_config = json.loads(config_path.read_text())
            print("Found existing Claude Desktop config.")
        except json.JSONDecodeError:
            print("Warning: Existing config is invalid, will create new one.")

    # Merge MCP servers
    mcp_servers = existing_config.get("mcpServers", {})
    mcp_servers.update(mcp_config)
    existing_config["mcpServers"] = mcp_servers

    # Write back
    config_path.write_text(json.dumps(existing_config, indent=2))

    print("Successfully installed Local Cocoa MCP to Claude Desktop!")
    print()
    print("Configuration added:")
    print(json.dumps({"mcpServers": mcp_config}, indent=2))
    print()
    print("Please restart Claude Desktop for changes to take effect.")


def show_manual_config():
    """Show configuration for manual installation."""
    mcp_config = generate_config()

    print("=" * 60)
    print("Manual Installation")
    print("=" * 60)
    print()
    print(f"Add the following to: {get_claude_config_path()}")
    print()
    print(json.dumps({"mcpServers": mcp_config}, indent=2))
    print()


def uninstall_config():
    """Remove MCP config from Claude Desktop."""
    config_path = get_claude_config_path()

    if not config_path.exists():
        print("Claude Desktop config not found. Nothing to uninstall.")
        return

    try:
        config = json.loads(config_path.read_text())

        if "mcpServers" in config and "local-cocoa" in config["mcpServers"]:
            del config["mcpServers"]["local-cocoa"]
            config_path.write_text(json.dumps(config, indent=2))
            print("Successfully removed Local Cocoa MCP from Claude Desktop.")
            print("Please restart Claude Desktop for changes to take effect.")
        else:
            print("Local Cocoa MCP was not installed.")
    except Exception as e:
        print(f"Error: {e}")


def main():
    print("=" * 60)
    print("Local Cocoa MCP Installer for Claude Desktop")
    print("=" * 60)
    print()

    # Show current detection
    print(f"Project root: {get_project_root()}")
    print(f"Python path:  {get_python_path()}")
    print(f"Data dir:     {get_data_dir()}")
    print()

    # Check if Local Cocoa is running / has been run
    api_key = get_api_key()
    if not api_key:
        print("Warning: No API key found. Please run Local Cocoa at least once first.")
        print(f"Expected key location: {get_dev_session_key_path()} (dev mode)")
        print("Or set LOCAL_COCOA_API_KEY environment variable.")
        print()

    # Ask user what to do
    print("What would you like to do?")
    print("1. Install to Claude Desktop automatically")
    print("2. Show configuration for manual installation")
    print("3. Uninstall from Claude Desktop")
    print("4. Exit")
    print()

    choice = input("Enter choice (1/2/3/4): ").strip()

    if choice == "1":
        print()
        install_config()
    elif choice == "2":
        print()
        show_manual_config()
    elif choice == "3":
        print()
        uninstall_config()
    else:
        print("Exiting.")


if __name__ == "__main__":
    main()

