from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from services.core.models import ApiKey
from services.core.context import get_storage
from services.core.auth import verify_api_key
import secrets

router = APIRouter(prefix="/security", tags=["security"])


class KeyStatusUpdate(BaseModel):
    is_active: bool


class KeyRenameRequest(BaseModel):
    name: str


@router.get("/keys", response_model=list[ApiKey])
async def list_keys(current_key: ApiKey = Depends(verify_api_key)):
    """List all API keys. Only accessible from authenticated requests."""
    storage = get_storage()
    return storage.list_api_keys()


@router.post("/keys", response_model=ApiKey)
async def create_key(name: str, current_key: ApiKey = Depends(verify_api_key)):
    """
    Create a new API key with the given name.
    
    Each MCP client should have its own unique API key for:
    - Independent access control (can disable one without affecting others)
    - Security isolation (if one key is compromised, revoke only that one)
    - Usage tracking (see which client is making requests)
    """
    storage = get_storage()
    # Generate a secure random key
    new_key_str = f"sk-{secrets.token_urlsafe(32)}"
    return storage.create_api_key(new_key_str, name)


@router.patch("/keys/{key}/status")
async def update_key_status(key: str, body: KeyStatusUpdate, current_key: ApiKey = Depends(verify_api_key)):
    """
    Enable or disable an API key without deleting it.
    
    This is useful for temporarily revoking access without losing the key configuration.
    Disabled keys will receive 403 Forbidden on all requests.
    """
    storage = get_storage()
    target_key = storage.get_api_key(key)
    if not target_key:
        raise HTTPException(status_code=404, detail="Key not found")

    if target_key.is_system:
        raise HTTPException(status_code=400, detail="Cannot modify system keys")

    if target_key.key == current_key.key and not body.is_active:
        raise HTTPException(status_code=400, detail="Cannot disable the key currently in use")

    success = storage.set_api_key_active(key, body.is_active)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update key status")
    
    return {"status": "enabled" if body.is_active else "disabled", "key": key}


@router.patch("/keys/{key}/name")
async def rename_key(key: str, body: KeyRenameRequest, current_key: ApiKey = Depends(verify_api_key)):
    """Rename an API key."""
    storage = get_storage()
    target_key = storage.get_api_key(key)
    if not target_key:
        raise HTTPException(status_code=404, detail="Key not found")

    if target_key.is_system:
        raise HTTPException(status_code=400, detail="Cannot modify system keys")

    success = storage.rename_api_key(key, body.name)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to rename key")
    
    return {"status": "renamed", "key": key, "name": body.name}


@router.delete("/keys/{key}")
async def delete_key(key: str, current_key: ApiKey = Depends(verify_api_key)):
    """
    Permanently delete an API key.
    
    Warning: This action cannot be undone. The MCP client using this key
    will immediately lose access. Consider disabling instead of deleting
    if you might want to restore access later.
    """
    storage = get_storage()
    target_key = storage.get_api_key(key)
    if not target_key:
        raise HTTPException(status_code=404, detail="Key not found")

    if target_key.is_system:
        raise HTTPException(status_code=400, detail="Cannot delete system keys")

    if target_key.key == current_key.key:
        raise HTTPException(status_code=400, detail="Cannot delete the key currently in use")

    success = storage.delete_api_key(key)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete key")
    return {"status": "deleted"}
