"""
Plugin System for Python Backend
Handles dynamic router registration, dependency isolation, and database prefixing
"""

from .loader import (
    PluginLoader,
    PluginMetadata,
    get_plugin_loader,
    init_plugin_loader,
)
from .registry import (
    PluginRegistry,
    get_plugin_registry,
)

__all__ = [
    "PluginLoader",
    "PluginMetadata",
    "get_plugin_loader",
    "init_plugin_loader",
    "PluginRegistry",
    "get_plugin_registry",
]

