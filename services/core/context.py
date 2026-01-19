from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from services.llm.client import EmbeddingClient, LlmClient, RerankClient, TranscriptionClient
from .config import settings

# Add plugins directory to path for importing plugin services
# We import directly from service modules to avoid circular imports with routers
if getattr(sys, 'frozen', False):
    # Running in a PyInstaller bundle inside Electron resources/local_rag_dist/local_rag_server/
    # The standard plugins directory is at resources/plugins
    # Path(sys.executable) is .../resources/local_rag_dist/local_rag_server/local_rag_server.exe
    _plugins_path = Path(sys.executable).parent.parent.parent / "plugins"
else:
    _plugins_path = (Path(__file__).resolve().parent.parent.parent / "plugins")

if str(_plugins_path) not in sys.path:
    sys.path.insert(0, str(_plugins_path))

# Import plugin services - import from service module directly, NOT from __init__
from mail.backend.service import EmailService
from notes.backend.service import NotesService

from services.indexer import Indexer
from services.search.engine import SearchEngine
from services.storage import IndexStorage
from .vector_store import get_vector_store

storage = IndexStorage(settings.db_path)
embedding_client = EmbeddingClient()
rerank_client = RerankClient()
llm_client = LlmClient()
transcription_client = TranscriptionClient() if settings.endpoints.transcription else None
indexer = Indexer(
    storage,
    embedding_client=embedding_client,
    llm_client=llm_client,
    transcription_client=transcription_client,
)
search_engine = SearchEngine(storage, embedding_client, rerank_client, llm_client, vectors=get_vector_store())
email_service = EmailService(storage, indexer)
notes_service = NotesService(storage, indexer)


def get_storage() -> IndexStorage:
    return storage


def get_indexer() -> Indexer:
    return indexer


def get_embedding_client() -> EmbeddingClient:
    return embedding_client


def get_rerank_client() -> RerankClient:
    return rerank_client


def get_llm_client() -> LlmClient:
    return llm_client


def get_search_engine() -> SearchEngine:
    return search_engine


def get_transcription_client() -> Optional[TranscriptionClient]:
    return transcription_client


def get_email_service() -> EmailService:
    return email_service


def get_notes_service() -> NotesService:
    return notes_service

