from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from services.core.context import get_storage, get_indexer
from services.core.models import FolderContentsResponse, FolderCreate, FolderListResponse, FolderRecord, PrivacyLevel
from services.core.request_context import get_request_context
from services.core.vector_store import get_vector_store
from services.storage import IndexStorage

logger = logging.getLogger(__name__)

# Request/Response models for privacy endpoints
class FolderPrivacyUpdateRequest(BaseModel):
    privacy_level: PrivacyLevel
    apply_to_files: bool = True  # Also update all files in the folder


class FolderPrivacyUpdateResponse(BaseModel):
    folder_id: str
    privacy_level: PrivacyLevel
    updated: bool
    files_updated: int

router = APIRouter(prefix="/folders", tags=["folders"])


def _folder_id(path: Path) -> str:
    digest = hashlib.sha1()
    digest.update(str(path.resolve()).encode("utf-8"))
    return digest.hexdigest()


@router.get("", response_model=FolderListResponse)
async def list_folders() -> FolderListResponse:
    storage = get_storage()
    loop = asyncio.get_running_loop()
    folders = await loop.run_in_executor(None, storage.list_folders)
    logger.info(f"[folders API] Returning {len(folders)} folders")
    return FolderListResponse(folders=folders)


@router.post("", response_model=FolderRecord, status_code=status.HTTP_201_CREATED)
async def add_folder(payload: FolderCreate) -> FolderRecord:
    storage = get_storage()
    indexer = get_indexer()
    resolved = payload.path.expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Folder does not exist or is not a directory.")

    loop = asyncio.get_running_loop()
    existing = await loop.run_in_executor(None, lambda: storage.folder_by_path(resolved))
    if existing:
        # If existing folder is 'manual' but we're now adding as 'full', upgrade it
        if existing.scan_mode == "manual" and payload.scan_mode == "full":
            existing.scan_mode = "full"
            existing.updated_at = dt.datetime.now(dt.timezone.utc)
            await loop.run_in_executor(None, lambda: storage.upsert_folder(existing))
        return existing

    now = dt.datetime.now(dt.timezone.utc)
    record = FolderRecord(
        id=_folder_id(resolved),
        path=resolved,
        label=payload.label or resolved.name,
        created_at=now,
        updated_at=now,
        enabled=True,
        scan_mode=payload.scan_mode,
    )
    await loop.run_in_executor(None, lambda: storage.upsert_folder(record))
    
    # Signal that new files may need processing
    indexer.signal_pending_files()
    
    return record


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def remove_folder(folder_id: str) -> Response:
    storage = get_storage()
    indexer = get_indexer()
    loop = asyncio.get_running_loop()
    folder = await loop.run_in_executor(None, lambda: storage.get_folder(folder_id))
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")

    # Cancel any ongoing indexing for this folder
    indexer.cancel_folder(folder_id)

    # Remove vectors
    await loop.run_in_executor(None, lambda: get_vector_store().delete_by_filter(folder_id=folder_id))

    await loop.run_in_executor(None, lambda: storage.remove_folder(folder_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{folder_id}", response_model=FolderRecord)
async def get_folder(folder_id: str) -> FolderRecord:
    storage = get_storage()
    loop = asyncio.get_running_loop()
    folder = await loop.run_in_executor(None, lambda: storage.get_folder(folder_id))
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    return folder


@router.get("/{folder_id}/files", response_model=FolderContentsResponse)
async def get_folder_files(folder_id: str) -> FolderContentsResponse:
    storage = get_storage()
    loop = asyncio.get_running_loop()
    folder = await loop.run_in_executor(None, lambda: storage.get_folder(folder_id))
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    files = await loop.run_in_executor(None, lambda: storage.folder_files(folder_id))
    return FolderContentsResponse(folder=folder, files=files)


# ========================================
# Privacy Level Management Endpoints
# ========================================

@router.put("/{folder_id}/privacy", response_model=FolderPrivacyUpdateResponse)
async def update_folder_privacy(folder_id: str, body: FolderPrivacyUpdateRequest) -> FolderPrivacyUpdateResponse:
    """
    Update the privacy level of a folder and optionally all its files.
    
    IMPORTANT: This endpoint can only be called from the local UI.
    External requests (API, MCP, plugins) cannot modify privacy settings.
    
    Privacy levels:
    - normal: Folder and files are accessible by all request sources
    - private: Folder and files are only accessible from local UI
    
    Args:
        folder_id: The folder ID
        body.privacy_level: The new privacy level
        body.apply_to_files: If True, also update all files in the folder
    """
    ctx = get_request_context()
    
    # CRITICAL: Only local UI can modify privacy settings
    if ctx.source != "local_ui":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Privacy settings can only be changed from Local Cocoa UI"
        )
    
    storage = get_storage()
    loop = asyncio.get_running_loop()
    folder = await loop.run_in_executor(None, lambda: storage.get_folder(folder_id))
    
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    
    # Update folder privacy level
    updated = await loop.run_in_executor(
        None, 
        lambda: storage.update_folder_privacy(folder_id, body.privacy_level)
    )
    
    files_updated = 0
    if body.apply_to_files:
        # Update all files in the folder
        files_updated = await loop.run_in_executor(
            None,
            lambda: storage.update_folder_files_privacy(folder_id, body.privacy_level)
        )
        
        # Update privacy level in vector store for all files
        files = await loop.run_in_executor(None, lambda: storage.folder_files(folder_id))
        for file in files:
            get_vector_store().update_privacy_level(file.id, body.privacy_level)
    
    return FolderPrivacyUpdateResponse(
        folder_id=folder_id,
        privacy_level=body.privacy_level,
        updated=updated,
        files_updated=files_updated,
    )


@router.get("/{folder_id}/privacy")
async def get_folder_privacy(folder_id: str) -> dict:
    """
    Get the privacy level of a folder.
    """
    storage = get_storage()
    loop = asyncio.get_running_loop()
    folder = await loop.run_in_executor(None, lambda: storage.get_folder(folder_id))
    
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    
    # Count files by privacy level
    files = await loop.run_in_executor(None, lambda: storage.folder_files(folder_id))
    normal_count = sum(1 for f in files if f.privacy_level == "normal")
    private_count = sum(1 for f in files if f.privacy_level == "private")
    
    return {
        "folder_id": folder_id,
        "privacy_level": folder.privacy_level,
        "files_normal": normal_count,
        "files_private": private_count,
    }
