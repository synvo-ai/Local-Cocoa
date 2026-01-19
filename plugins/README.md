# Plugins

All plugins are stored in this directory. Each plugin is a self-contained directory with its own backend and optional frontend.

## Directory Structure

```
plugins/
  your-plugin/
    plugin.json      # Plugin manifest (required)
    backend/
      __init__.py
      router.py      # FastAPI router (required)
      service.py     # Business logic
    frontend/        # Optional frontend assets
```

## Creating a New Plugin

1. **Copy an existing plugin** as a starting point:
   - `notes/` - Simple CRUD operations (recommended for beginners)
   - `activity/` - File upload + async processing
   - `mail/` - OAuth flows + multi-account management

2. **Update `plugin.json`**:
```json
{
    "id": "your-plugin",
    "name": "Your Plugin Name",
    "version": "1.0.0",
    "description": "What your plugin does",
    "author": "Your Name",
    "category": "productivity",
    "icon": "Sparkles",
    "backend": {
        "entrypoint": "router"
    }
}
```

3. **Implement your router** in `backend/router.py`:
```python
from fastapi import APIRouter

router = APIRouter(tags=["plugin-your-plugin"])

@router.get("/hello")
def hello():
    return {"message": "Hello from your plugin!"}
```

## API Path

Your plugin's API will be available at:
```
/plugins/{plugin-id}/...
```

For example, if your plugin ID is `my-plugin` and you have a `/hello` endpoint:
```
GET /plugins/my-plugin/hello
```

## Built-in Plugins

| Plugin | Description | Complexity |
|--------|-------------|------------|
| `activity` | Screen activity tracking with AI summaries | Medium |
| `mail` | Email account management with Outlook OAuth | Complex |
| `notes` | Simple note-taking with local storage | Simple |

## Hot Reload

Plugins support **hot reload** - you can modify plugin code and reload without restarting the app:

### From the UI
1. Go to **Settings > Plugins**
2. Click the **↻** (reload) button next to a plugin

### From API
```bash
# Reload a specific plugin
POST /system/plugins/reload/{plugin-id}

# Refresh all plugins (re-discover and reload)
POST /system/plugins/refresh
```

### What happens during hot reload:
1. Plugin's existing API routes are removed
2. Plugin manifest is re-read (in case it changed)
3. Python modules are cleared from cache
4. Plugin router is re-loaded and registered

**Note:** Frontend hot reload requires the Electron side to reload the plugin webview.

## Plugin Isolation

### Backend (Python)
- Each plugin's router is registered under `/plugins/{plugin-id}/`
- `sys.path` is temporarily modified during plugin load for dependency isolation
- Plugins can have their own `venv/` for dependency isolation

### Frontend (Electron)
- Third-party plugins run in isolated `<webview>` elements
- Each plugin gets a separate session (`partition:plugin:{id}`)
- Plugins communicate via `window.pluginAPI` (exposed by `pluginPreload.ts`)
- No direct Node.js access - all operations go through IPC

## Tips

- Use `services.core.context` to access shared services (storage, indexer, LLM client)
- Keep your router clean - put business logic in `service.py`
- Use the `tags` parameter in `APIRouter` for OpenAPI documentation
- Use `get_plugin_loader().get_db_table_prefix(plugin_id)` for database table names to avoid conflicts

