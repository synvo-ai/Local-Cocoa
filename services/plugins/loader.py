"""
Plugin Loader
Dynamically discovers and loads plugin routers with dependency isolation
"""

from __future__ import annotations

import json
import logging
import sys
import importlib
import importlib.util
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI, APIRouter

logger = logging.getLogger(__name__)


@dataclass
class PluginMetadata:
    """Plugin manifest information"""
    id: str
    name: str
    version: str
    description: str = ""
    author: str = ""
    category: str = "custom"
    
    # Backend configuration
    backend_entrypoint: str = "router"
    router_module: Optional[str] = None
    db_init: Optional[str] = None
    db_migrate: Optional[str] = None
    requirements: Optional[str] = None
    
    # Runtime state
    path: Path = field(default_factory=Path)
    loaded: bool = False
    error: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any], plugin_path: Path) -> "PluginMetadata":
        """Create PluginMetadata from manifest dict"""
        backend_config = data.get("backend", {})
        return cls(
            id=data["id"],
            name=data["name"],
            version=data["version"],
            description=data.get("description", ""),
            author=data.get("author", ""),
            category=data.get("category", "custom"),
            backend_entrypoint=backend_config.get("entrypoint", "router"),
            router_module=backend_config.get("routerModule"),
            db_init=backend_config.get("dbInit"),
            db_migrate=backend_config.get("dbMigrate"),
            requirements=backend_config.get("requirements"),
            path=plugin_path,
        )


class PluginLoader:
    """
    Manages plugin discovery and loading for the Python backend.
    
    Key features:
    - Dynamic router registration with unique API prefix per plugin
    - Dependency isolation via sys.path manipulation
    - Database table name prefixing
    
    All plugins (including built-in ones like Activity, Mail, Notes) are stored
    in the same plugins/ directory for simplicity.
    """
    
    PLUGINS_DIR = "plugins"
    MANIFEST_NAME = "plugin.json"
    
    def __init__(self, base_dir: Path, user_data_dir: Optional[Path] = None):
        """
        Initialize the plugin loader.
        
        Args:
            base_dir: Base directory of the application (where plugins/ directory is)
            user_data_dir: Not used anymore, kept for backwards compatibility
        """
        self.base_dir = Path(base_dir)
        self.plugins_path = self.base_dir / self.PLUGINS_DIR
        
        self.plugins: Dict[str, PluginMetadata] = {}
        self._original_sys_path: List[str] = []
        
        logger.info(f"PluginLoader initialized. Plugins directory: {self.plugins_path}")
    
    def discover_plugins(self) -> List[PluginMetadata]:
        """
        Discover all available plugins in the plugins/ directory.
        
        Returns:
            List of discovered plugin metadata
        """
        discovered = []
        
        if self.plugins_path.exists():
            for plugin_dir in self.plugins_path.iterdir():
                if plugin_dir.is_dir():
                    metadata = self._load_plugin_metadata(plugin_dir)
                    if metadata:
                        discovered.append(metadata)
                        self.plugins[metadata.id] = metadata
        else:
            logger.warning(f"Plugins directory not found: {self.plugins_path}")
        
        logger.info(f"Discovered {len(discovered)} plugins: {[p.id for p in discovered]}")
        return discovered
    
    def _load_plugin_metadata(self, plugin_dir: Path) -> Optional[PluginMetadata]:
        """Load plugin metadata from manifest file"""
        manifest_path = plugin_dir / self.MANIFEST_NAME
        
        if not manifest_path.exists():
            logger.warning(f"No manifest found in {plugin_dir}")
            return None
        
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest_data = json.load(f)
            
            # Validate required fields
            if not all(k in manifest_data for k in ["id", "name", "version"]):
                logger.warning(f"Invalid manifest in {plugin_dir}: missing required fields")
                return None
            
            metadata = PluginMetadata.from_dict(manifest_data, plugin_dir)
            logger.debug(f"Loaded plugin metadata: {metadata.name} ({metadata.id})")
            return metadata
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse manifest in {plugin_dir}: {e}")
            return None
        except Exception as e:
            logger.error(f"Error loading plugin metadata from {plugin_dir}: {e}")
            return None
    
    def register_all_routers(self, app: "FastAPI") -> int:
        """
        Register all discovered plugin routers with the FastAPI app.
        
        Each plugin gets a unique prefix: /plugins/{plugin_id}/
        
        Args:
            app: FastAPI application instance
            
        Returns:
            Number of successfully registered plugins
        """
        registered = 0
        
        for plugin_id, metadata in self.plugins.items():
            if not metadata.backend_entrypoint:
                continue
                
            try:
                router = self._load_plugin_router(metadata)
                if router:
                    # Register with unique prefix
                    prefix = f"/plugins/{plugin_id}"
                    app.include_router(router, prefix=prefix, tags=[f"plugin:{metadata.name}"])
                    metadata.loaded = True
                    registered += 1
                    logger.info(f"Registered plugin router: {metadata.name} at {prefix}")
            except Exception as e:
                metadata.error = str(e)
                logger.error(f"Failed to register plugin {plugin_id}: {e}")
        
        return registered
    
    def _load_plugin_router(self, metadata: PluginMetadata) -> Optional["APIRouter"]:
        """
        Load a plugin's FastAPI router with dependency isolation.
        
        Uses sys.path manipulation to ensure the plugin can find its dependencies
        without affecting other plugins.
        
        Always loads router.py directly to avoid circular import issues.
        """
        backend_path = metadata.path / "backend"
        
        if not backend_path.exists():
            logger.warning(f"Plugin {metadata.id} has no backend directory")
            return None
        
        # Save original sys.path
        self._original_sys_path = sys.path.copy()
        
        try:
            # Add plugin path to sys.path for package imports
            # This allows the plugin to import its own modules as a package
            sys.path.insert(0, str(metadata.path))
            sys.path.insert(0, str(backend_path))
            
            # Also add plugin's venv if it exists
            venv_path = backend_path / "venv"
            if venv_path.exists():
                site_packages = self._find_site_packages(venv_path)
                if site_packages:
                    sys.path.insert(0, str(site_packages))
            
            # Always load router.py directly to avoid circular imports
            # The router module should be the entrypoint
            module_name_to_load = metadata.router_module or metadata.backend_entrypoint
            router_path = backend_path / f"{module_name_to_load}.py"
            
            if not router_path.exists():
                logger.error(f"Plugin router module not found: {router_path}")
                return None
            
            # Register the backend package first if __init__.py exists
            # This enables relative imports within the plugin
            init_path = backend_path / "__init__.py"
            if init_path.exists():
                # Create an empty package module for the backend
                backend_module_name = f"plugin_{metadata.id}_backend"
                backend_module = type(sys)("backend")
                backend_module.__path__ = [str(backend_path)]
                backend_module.__package__ = "backend"
                sys.modules["backend"] = backend_module
                sys.modules[backend_module_name] = backend_module
            
            # Now load the router module
            module_name = f"plugin_{metadata.id}_{module_name_to_load}"
            spec = importlib.util.spec_from_file_location(
                module_name,
                router_path,
                submodule_search_locations=[str(backend_path)]
            )
            if not spec or not spec.loader:
                logger.error(f"Failed to create module spec for {router_path}")
                return None
            
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
            
            # Get the router from the module
            router = getattr(module, "router", None)
            if router is None:
                logger.error(f"Plugin {metadata.id} module has no 'router' attribute")
                return None
            
            return router
            
        finally:
            # Restore original sys.path
            sys.path = self._original_sys_path
            # Clean up temporary module registrations
            if "backend" in sys.modules:
                del sys.modules["backend"]
    
    def _find_site_packages(self, venv_path: Path) -> Optional[Path]:
        """Find site-packages directory in a virtualenv"""
        # Try common locations
        candidates = [
            venv_path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages",
            venv_path / "Lib" / "site-packages",  # Windows
        ]
        
        for candidate in candidates:
            if candidate.exists():
                return candidate
        
        return None
    
    def get_plugin(self, plugin_id: str) -> Optional[PluginMetadata]:
        """Get plugin metadata by ID"""
        return self.plugins.get(plugin_id)
    
    def get_plugin_api_base(self, plugin_id: str) -> Optional[str]:
        """
        Get the API base path for a plugin.
        Useful for inter-plugin communication.
        """
        if plugin_id in self.plugins:
            return f"/plugins/{plugin_id}"
        return None
    
    def list_plugins(self) -> List[Dict[str, Any]]:
        """List all plugins with their status"""
        return [
            {
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "description": m.description,
                "author": m.author,
                "category": m.category,
                "loaded": m.loaded,
                "error": m.error,
            }
            for m in self.plugins.values()
        ]
    
    def unload_plugin(self, app: "FastAPI", plugin_id: str) -> bool:
        """
        Unload a plugin's router from the FastAPI app.
        
        This enables hot-reload by removing routes before re-adding them.
        
        Args:
            app: FastAPI application instance
            plugin_id: Plugin ID to unload
            
        Returns:
            True if plugin was unloaded, False if not found
        """
        if plugin_id not in self.plugins:
            logger.warning(f"Plugin not found for unload: {plugin_id}")
            return False
        
        metadata = self.plugins[plugin_id]
        
        # Remove routes with matching prefix
        prefix = f"/plugins/{plugin_id}"
        routes_to_remove = []
        
        for i, route in enumerate(app.router.routes):
            # Check if route path starts with our plugin prefix
            route_path = getattr(route, "path", "")
            if route_path.startswith(prefix):
                routes_to_remove.append(i)
        
        # Remove routes in reverse order to avoid index shifting
        for i in sorted(routes_to_remove, reverse=True):
            del app.router.routes[i]
        
        metadata.loaded = False
        logger.info(f"Unloaded plugin: {plugin_id} (removed {len(routes_to_remove)} routes)")
        return True
    
    def reload_plugin(self, app: "FastAPI", plugin_id: str) -> bool:
        """
        Hot-reload a plugin by unloading and re-loading it.
        
        Args:
            app: FastAPI application instance
            plugin_id: Plugin ID to reload
            
        Returns:
            True if plugin was reloaded successfully
        """
        if plugin_id not in self.plugins:
            logger.warning(f"Plugin not found for reload: {plugin_id}")
            return False
        
        # Unload existing routes
        self.unload_plugin(app, plugin_id)
        
        # Re-read manifest in case it changed
        metadata = self.plugins[plugin_id]
        manifest_path = metadata.path / self.MANIFEST_NAME
        
        if manifest_path.exists():
            try:
                with open(manifest_path, "r", encoding="utf-8") as f:
                    manifest_data = json.load(f)
                
                # Update metadata
                new_metadata = PluginMetadata.from_dict(manifest_data, metadata.path)
                self.plugins[plugin_id] = new_metadata
                metadata = new_metadata
            except Exception as e:
                logger.error(f"Failed to re-read manifest for {plugin_id}: {e}")
        
        # Clear any cached modules for this plugin
        modules_to_remove = [
            name for name in sys.modules
            if name.startswith(f"plugin_{plugin_id}")
        ]
        for module_name in modules_to_remove:
            del sys.modules[module_name]
        
        # Re-load the router
        try:
            router = self._load_plugin_router(metadata)
            if router:
                prefix = f"/plugins/{plugin_id}"
                app.include_router(router, prefix=prefix, tags=[f"plugin:{metadata.name}"])
                metadata.loaded = True
                logger.info(f"Reloaded plugin: {plugin_id}")
                return True
        except Exception as e:
            metadata.error = str(e)
            logger.error(f"Failed to reload plugin {plugin_id}: {e}")
        
        return False
    
    def refresh_plugins(self, app: "FastAPI") -> int:
        """
        Refresh all plugins by re-discovering and re-loading.
        
        Args:
            app: FastAPI application instance
            
        Returns:
            Number of plugins reloaded
        """
        logger.info("Refreshing all plugins...")
        
        # Unload all currently loaded plugins
        for plugin_id, metadata in self.plugins.items():
            if metadata.loaded:
                self.unload_plugin(app, plugin_id)
        
        # Clear plugin registry
        self.plugins.clear()
        
        # Re-discover
        self.discover_plugins()
        
        # Re-register all
        return self.register_all_routers(app)
    
    def get_db_table_prefix(self, plugin_id: str) -> str:
        """
        Get database table prefix for a plugin.
        All plugin tables should be prefixed with this to avoid conflicts.
        
        Format: plugin_{sanitized_id}_
        """
        # Sanitize plugin ID for table naming
        sanitized = plugin_id.replace(".", "_").replace("-", "_").lower()
        return f"plugin_{sanitized}_"


# Global singleton
_plugin_loader: Optional[PluginLoader] = None


def init_plugin_loader(base_dir: Path, user_data_dir: Optional[Path] = None) -> PluginLoader:
    """Initialize the global plugin loader"""
    global _plugin_loader
    _plugin_loader = PluginLoader(base_dir, user_data_dir)
    return _plugin_loader


def get_plugin_loader() -> Optional[PluginLoader]:
    """Get the global plugin loader instance"""
    return _plugin_loader


