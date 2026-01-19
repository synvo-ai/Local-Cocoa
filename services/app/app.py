# Core Routers
from services.drive import files_router as files
from services.drive import folders_router as folders
from services.indexer import router as index
from services.search import router as search
from services.memory import router as memory
from .routers import chat, health, settings as settings_router, security, plugins as plugins_router, language as language_router

from services.core.context import get_indexer, get_storage
from services.core.config import settings
from services.core.models import FolderRecord
from services.core.auth import verify_api_key, ensure_local_key

# Plugin system
from services.plugins import init_plugin_loader

import asyncio
import logging
import hashlib
import datetime as dt
from pathlib import Path
import sys

# Force ProactorEventLoop on Windows to avoid "too many file descriptors" error
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

logger = logging.getLogger(__name__)

app = FastAPI(title="Local RAG Agent", version="1.0.0", dependencies=[Depends(verify_api_key)])

# Allow CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include core routers
app.include_router(health.router)
app.include_router(folders)
app.include_router(index.router)
app.include_router(files)
app.include_router(search.router)
app.include_router(memory)
app.include_router(chat.router)
app.include_router(settings_router.router)
app.include_router(security.router)
app.include_router(plugins_router.router)
app.include_router(language_router.router)

# Initialize plugin system and load plugins at startup
# This ensures plugin routes are available before the first request
# Note: base_dir is the project root (where plugins/ directory is located)
if getattr(sys, 'frozen', False):
    # In packaged Windows app: <resources>/local_rag_dist/local_rag_server/local_rag_server.exe
    # We want <resources> as the project root so <resources>/plugins/ is found
    _resource_root = Path(sys.executable).parent.parent.parent
else:
    _resource_root = Path(__file__).parent.parent.parent  # services/app/app.py -> project root
try:
    plugin_loader = init_plugin_loader(_resource_root)
    plugin_loader.discover_plugins()
    registered_count = plugin_loader.register_all_routers(app)
    logger.info(f"Plugin system initialized: {registered_count} plugins loaded")
except Exception as e:
    logger.error(f"Failed to initialize plugin system: {e}")
    import traceback
    traceback.print_exc()

_poll_task: asyncio.Task | None = None
_startup_refresh_task: asyncio.Task | None = None
_staged_scheduler_task: asyncio.Task | None = None


def _track_task(task: asyncio.Task, name: str) -> None:
    def _finalise(completed: asyncio.Task) -> None:
        try:
            completed.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s task failed: %s", name, exc)

    task.add_done_callback(_finalise)


async def _poll_loop(interval: int) -> None:
    indexer = get_indexer()
    while True:
        await asyncio.sleep(interval)
        # Use skip_pending_registration for poll refresh to avoid expensive DB operations
        # Use skip_recently_indexed_minutes to avoid re-scanning folders that were just indexed
        # Set to half the poll interval to ensure we eventually rescan
        skip_minutes = max(1, interval // 120)  # e.g., 90s poll -> skip if indexed <1 min ago
        await indexer.refresh(
            skip_pending_registration=True,
            skip_recently_indexed_minutes=skip_minutes
        )
        
        # After refresh, trigger staged indexing if there are pending files
        # This ensures newly discovered files get processed immediately
        await indexer.trigger_staged_if_pending()


async def _staged_scheduler_loop(max_wait: int = 60) -> None:
    """Background loop that processes pending files using staged indexing.
    
    Uses event-based triggering for immediate response, with a max wait timeout
    to catch any files that might have been missed.
    """
    indexer = get_indexer()
    pending_event = indexer.get_pending_files_event()
    
    while True:
        try:
            # Wait for either:
            # 1. The pending files event to be signaled (immediate trigger)
            # 2. Timeout (fallback check every max_wait seconds)
            try:
                await asyncio.wait_for(pending_event.wait(), timeout=max_wait)
                pending_event.clear()  # Reset for next signal
            except asyncio.TimeoutError:
                pass  # Timeout is fine, we'll check anyway
            
            # Trigger staged indexing if there are pending files
            await indexer.trigger_staged_if_pending()
            
        except Exception as e:
            logger.warning("Staged scheduler loop error: %s", e)
            await asyncio.sleep(5)  # Brief pause on error


@app.on_event("startup")
async def on_startup() -> None:
    global _poll_task, _startup_refresh_task, _staged_scheduler_task

    # Ensure local-key exists and is written to file for frontend
    ensure_local_key(settings.base_dir)

    indexer = get_indexer()
    if settings.refresh_on_startup:
        # Launch initial refresh without blocking server startup so the API becomes responsive quickly.
        # Use skip_pending_registration=True to avoid expensive DB operations during startup
        # Use skip_recently_indexed_minutes=5 to skip folders that were indexed recently
        # (e.g., user just closed and reopened the app)
        _startup_refresh_task = asyncio.create_task(
            indexer.refresh(skip_pending_registration=True, skip_recently_indexed_minutes=5)
        )
        _track_task(_startup_refresh_task, "startup-refresh")
    if settings.poll_interval_seconds > 0:
        _poll_task = asyncio.create_task(_poll_loop(settings.poll_interval_seconds))
        _track_task(_poll_task, "poll-loop")
    
    # Start staged scheduler loop (checks every 10 seconds for pending files)
    _staged_scheduler_task = asyncio.create_task(_staged_scheduler_loop(10))
    _track_task(_staged_scheduler_task, "staged-scheduler")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _poll_task, _startup_refresh_task, _staged_scheduler_task
    if _poll_task:
        _poll_task.cancel()
        try:
            await _poll_task
        except asyncio.CancelledError:
            # Expected when cancelling task on shutdown - safe to ignore
            pass
        _poll_task = None
    if _startup_refresh_task:
        _startup_refresh_task.cancel()
        try:
            await _startup_refresh_task
        except asyncio.CancelledError:
            # Expected when cancelling task on shutdown - safe to ignore
            pass
        _startup_refresh_task = None
    if _staged_scheduler_task:
        _staged_scheduler_task.cancel()
        try:
            await _staged_scheduler_task
        except asyncio.CancelledError:
            # Expected when cancelling task on shutdown - safe to ignore
            pass
        _staged_scheduler_task = None
