"""
Plugin Registry
Central registry for plugin discovery and inter-plugin communication
"""

from __future__ import annotations

import logging
from typing import Optional, Dict, Any, Callable, TYPE_CHECKING
from dataclasses import dataclass, field

if TYPE_CHECKING:
    from fastapi import APIRouter

logger = logging.getLogger(__name__)


@dataclass
class RegisteredPlugin:
    """A registered plugin with its capabilities"""
    id: str
    name: str
    api_base: str
    router: Optional["APIRouter"] = None
    capabilities: Dict[str, Any] = field(default_factory=dict)
    

class PluginRegistry:
    """
    Central registry for plugins.
    
    Provides:
    - Plugin discovery for inter-plugin communication
    - Service registration and lookup
    - Event pub/sub between plugins
    """
    
    def __init__(self):
        self._plugins: Dict[str, RegisteredPlugin] = {}
        self._services: Dict[str, Dict[str, Callable]] = {}  # plugin_id -> service_name -> callable
        self._event_handlers: Dict[str, list] = {}  # event_name -> [handlers]
    
    def register_plugin(
        self,
        plugin_id: str,
        name: str,
        api_base: str,
        router: Optional["APIRouter"] = None,
        capabilities: Optional[Dict[str, Any]] = None
    ) -> None:
        """Register a plugin in the registry"""
        self._plugins[plugin_id] = RegisteredPlugin(
            id=plugin_id,
            name=name,
            api_base=api_base,
            router=router,
            capabilities=capabilities or {}
        )
        logger.info(f"Registered plugin: {name} ({plugin_id}) at {api_base}")
    
    def unregister_plugin(self, plugin_id: str) -> bool:
        """Unregister a plugin from the registry"""
        if plugin_id in self._plugins:
            del self._plugins[plugin_id]
            # Clean up services
            if plugin_id in self._services:
                del self._services[plugin_id]
            logger.info(f"Unregistered plugin: {plugin_id}")
            return True
        return False
    
    def get_plugin(self, plugin_id: str) -> Optional[RegisteredPlugin]:
        """Get a registered plugin by ID"""
        return self._plugins.get(plugin_id)
    
    def get_plugin_api_base(self, plugin_id: str) -> Optional[str]:
        """Get the API base URL for a plugin"""
        plugin = self._plugins.get(plugin_id)
        return plugin.api_base if plugin else None
    
    def list_plugins(self) -> list[Dict[str, Any]]:
        """List all registered plugins"""
        return [
            {
                "id": p.id,
                "name": p.name,
                "api_base": p.api_base,
                "capabilities": p.capabilities
            }
            for p in self._plugins.values()
        ]
    
    # Service registration for inter-plugin calls
    
    def register_service(self, plugin_id: str, service_name: str, handler: Callable) -> None:
        """
        Register a service that other plugins can call.
        
        Example:
            registry.register_service("my-plugin", "process_data", my_handler)
            
        Other plugins can then call:
            registry.call_service("my-plugin", "process_data", data={"key": "value"})
        """
        if plugin_id not in self._services:
            self._services[plugin_id] = {}
        self._services[plugin_id][service_name] = handler
        logger.debug(f"Registered service: {plugin_id}/{service_name}")
    
    def call_service(self, plugin_id: str, service_name: str, **kwargs) -> Any:
        """
        Call a service registered by another plugin.
        
        Raises:
            KeyError: If plugin or service not found
        """
        if plugin_id not in self._services:
            raise KeyError(f"Plugin {plugin_id} has no registered services")
        if service_name not in self._services[plugin_id]:
            raise KeyError(f"Service {service_name} not found in plugin {plugin_id}")
        
        handler = self._services[plugin_id][service_name]
        return handler(**kwargs)
    
    def has_service(self, plugin_id: str, service_name: str) -> bool:
        """Check if a service exists"""
        return (
            plugin_id in self._services and 
            service_name in self._services[plugin_id]
        )
    
    # Event pub/sub
    
    def subscribe(self, event_name: str, handler: Callable) -> Callable[[], None]:
        """
        Subscribe to an event.
        
        Returns:
            Unsubscribe function
        """
        if event_name not in self._event_handlers:
            self._event_handlers[event_name] = []
        self._event_handlers[event_name].append(handler)
        
        def unsubscribe():
            if event_name in self._event_handlers:
                self._event_handlers[event_name].remove(handler)
        
        return unsubscribe
    
    def publish(self, event_name: str, **data) -> None:
        """
        Publish an event to all subscribers.
        
        Handlers are called synchronously. For async handlers,
        use publish_async.
        """
        handlers = self._event_handlers.get(event_name, [])
        for handler in handlers:
            try:
                handler(**data)
            except Exception as e:
                logger.error(f"Error in event handler for {event_name}: {e}")
    
    async def publish_async(self, event_name: str, **data) -> None:
        """Publish an event and await all async handlers"""
        import asyncio
        handlers = self._event_handlers.get(event_name, [])
        tasks = []
        for handler in handlers:
            try:
                result = handler(**data)
                if asyncio.iscoroutine(result):
                    tasks.append(result)
            except Exception as e:
                logger.error(f"Error in event handler for {event_name}: {e}")
        
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


# Global singleton
_plugin_registry: Optional[PluginRegistry] = None


def get_plugin_registry() -> PluginRegistry:
    """Get the global plugin registry instance"""
    global _plugin_registry
    if _plugin_registry is None:
        _plugin_registry = PluginRegistry()
    return _plugin_registry

