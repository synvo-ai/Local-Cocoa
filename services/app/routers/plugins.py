"""
Plugin Management API Router

Provides endpoints for managing plugins including:
- Listing installed plugins
- Hot-reloading plugins
- Refreshing all plugins
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from services.plugins import get_plugin_loader

router = APIRouter(prefix="/system/plugins", tags=["plugins"])


class PluginInfo(BaseModel):
    """Plugin information response model"""
    id: str
    name: str
    version: str
    description: str = ""
    author: str = ""
    category: str = "custom"
    loaded: bool = False
    error: Optional[str] = None


class PluginActionResult(BaseModel):
    """Result of a plugin action"""
    success: bool
    message: str
    plugin_id: Optional[str] = None


@router.get("", response_model=List[PluginInfo])
async def list_plugins():
    """List all installed plugins with their status"""
    loader = get_plugin_loader()
    if not loader:
        return []
    
    return loader.list_plugins()


@router.post("/reload/{plugin_id}", response_model=PluginActionResult)
async def reload_plugin(plugin_id: str):
    """
    Hot-reload a specific plugin.
    
    This will:
    1. Unload the plugin's existing routes
    2. Re-read the plugin manifest
    3. Re-load the plugin's router
    
    No server restart required.
    """
    loader = get_plugin_loader()
    if not loader:
        raise HTTPException(status_code=500, detail="Plugin system not initialized")
    
    # Import app here to avoid circular import
    from services.app.app import app
    
    if plugin_id not in loader.plugins:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")
    
    try:
        success = loader.reload_plugin(app, plugin_id)
        if success:
            return PluginActionResult(
                success=True,
                message=f"Plugin {plugin_id} reloaded successfully",
                plugin_id=plugin_id
            )
        else:
            return PluginActionResult(
                success=False,
                message=f"Failed to reload plugin {plugin_id}",
                plugin_id=plugin_id
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/refresh", response_model=PluginActionResult)
async def refresh_plugins():
    """
    Refresh all plugins.
    
    This will:
    1. Unload all currently loaded plugins
    2. Re-discover plugins from the plugins directory
    3. Re-load all plugins
    
    No server restart required.
    """
    loader = get_plugin_loader()
    if not loader:
        raise HTTPException(status_code=500, detail="Plugin system not initialized")
    
    # Import app here to avoid circular import
    from services.app.app import app
    
    try:
        count = loader.refresh_plugins(app)
        return PluginActionResult(
            success=True,
            message=f"Refreshed {count} plugins"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{plugin_id}/api-base", response_model=dict)
async def get_plugin_api_base(plugin_id: str):
    """Get the API base path for a plugin (for inter-plugin communication)"""
    loader = get_plugin_loader()
    if not loader:
        raise HTTPException(status_code=500, detail="Plugin system not initialized")
    
    api_base = loader.get_plugin_api_base(plugin_id)
    if not api_base:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")
    
    return {"api_base": api_base}

