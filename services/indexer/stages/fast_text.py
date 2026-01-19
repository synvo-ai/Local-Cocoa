"""Fast Text Processor - Round 1 Stage 1.

Extracts text from files using fast methods (PyMuPDF, OCR).
Produces text chunks that enable keyword search immediately.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import mimetypes
from pathlib import Path
from typing import Optional

from services.chunker import ChunkingPipeline, chunking_pipeline
from services.core.config import settings
from services.core.content import ContentRouter, content_router
from services.core.models import (
    ChunkSnapshot,
    FileRecord,
    FolderRecord,
    IngestArtifact,
    infer_kind,
)
from services.storage import IndexStorage
from ..scanner import fingerprint  # Note: checksum removed for performance
from ..state import StateManager

logger = logging.getLogger(__name__)

# Memory integration (optional)
try:
    from services.memory.service import get_memory_service
    from services.memory.api_specs.dtos.memory_command import RawData
    from services.memory.api_specs.memory_types import RawDataType, MemoryType
    from services.storage.memory import (
        EpisodeRecord as StorageEpisodeRecord,
        EventLogRecord as StorageEventLogRecord,
        ForesightRecord as StorageForesightRecord,
    )
    import uuid
    MEMORY_AVAILABLE = True
except ImportError:
    MEMORY_AVAILABLE = False


class FastTextProcessor:
    """Round 1 Stage 1: Fast text extraction.
    
    Responsibilities:
    - Extract text from files using fast methods (PyMuPDF OCR, text extraction)
    - Generate text chunks (v1)
    - Store chunks in SQLite (FTS5 for keyword search)
    - Update fast_stage from 0 -> 1
    
    Does NOT:
    - Generate embeddings (that's FastEmbedProcessor)
    - Use VLM vision models (that's DeepProcessor)
    """

    def __init__(
        self,
        storage: IndexStorage,
        state_manager: StateManager,
        *,
        content: ContentRouter = content_router,
        chunker: ChunkingPipeline = chunking_pipeline,
        enable_memory_extraction: bool = True,
        memory_user_id: str = "default_user",
    ) -> None:
        self.storage = storage
        self.state_manager = state_manager
        self.content_router = content
        self.chunker = chunker
        self.enable_memory_extraction = enable_memory_extraction
        self.memory_user_id = memory_user_id

    async def process(self, file_id: str) -> bool:
        """Process a single file: extract text and create chunks.
        
        Args:
            file_id: The file ID to process
            
        Returns:
            True if successful, False otherwise
        """
        file_record = self.storage.get_file(file_id)
        if not file_record:
            logger.warning("File not found: %s", file_id)
            return False

        if file_record.fast_stage >= 1:
            logger.debug("File %s already has fast_stage >= 1, skipping", file_id)
            return True

        path = file_record.path
        if not path.exists():
            logger.warning("File path does not exist: %s", path)
            self.storage.update_file_stage(file_id, fast_stage=-1)
            return False

        try:
            # Update state for UI
            self.state_manager.set_active_stage(
                stage="fast_text",
                detail=f"Extracting text from {path.name}",
                progress=0.0,
                event=f"Processing {path.name}"
            )

            # Parse file content using fast mode
            parsed = await asyncio.to_thread(
                self.content_router.parse, path, indexing_mode="fast"
            )

            # Build metadata
            stat = path.stat()
            extension = path.suffix.lower().lstrip(".")
            mime_type, _ = mimetypes.guess_type(str(path))
            
            # OPTIMIZATION: Skip expensive SHA256 checksum during fast indexing.
            # Use a lightweight fingerprint (size + mtime) for change detection.
            # Full checksum can be computed lazily during deep indexing if needed.
            # This saves ~30-50% of processing time for large files.
            lightweight_checksum = f"size:{stat.st_size}:mtime:{int(stat.st_mtime)}"

            # Update file record with parsed content
            file_record.mime_type = mime_type
            file_record.checksum_sha256 = lightweight_checksum  # Lightweight checksum for fast mode
            file_record.duration_seconds = parsed.duration_seconds
            file_record.page_count = parsed.page_count
            file_record.preview_image = parsed.preview_image
            
            # Merge metadata
            file_record.metadata = file_record.metadata or {}
            file_record.metadata.update(parsed.metadata)
            file_record.metadata["file_name"] = file_record.name
            file_record.metadata["name"] = file_record.name
            file_record.metadata["path"] = str(file_record.path)
            file_record.metadata["full_path"] = str(file_record.path)
            file_record.metadata["folder_id"] = file_record.folder_id
            file_record.metadata["extension"] = file_record.extension
            file_record.metadata["size"] = file_record.size
            file_record.metadata["kind"] = file_record.kind

            # Create artifact for chunking
            artifact = IngestArtifact(
                record=file_record,
                text=parsed.text,
                chunks=[],
                page_mapping=parsed.page_mapping
            )

            # Build chunks
            chunks = self._build_chunks(file_record, artifact)
            
            # Set chunk version to "fast"
            for chunk in chunks:
                chunk.version = "fast"

            # Store chunks in SQLite (FTS5 will auto-sync)
            self.storage.replace_chunks(file_id, chunks, version="fast")

            # Update file record
            file_record.metadata["vector_chunks_fast"] = [c.chunk_id for c in chunks]
            file_record.metadata["chunk_count_fast"] = len(chunks)
            file_record.metadata["chunk_strategy"] = "fast_text_v1"
            
            # Generate summary from first chunk
            if chunks and chunks[0].text:
                file_record.summary = chunks[0].text[:500]

            # Update stage
            now = dt.datetime.now(dt.timezone.utc)
            file_record.fast_stage = 1
            file_record.fast_text_at = now
            file_record.index_status = "pending"  # Still pending until embed done

            self.storage.upsert_file(file_record)

            logger.info(
                "Fast text completed for %s: %d chunks created",
                path.name, len(chunks)
            )

            # Trigger memory extraction in background (non-blocking)
            logger.info(
                "🧠 Memory check: enable=%s, available=%s, text_len=%d",
                self.enable_memory_extraction, MEMORY_AVAILABLE, len(artifact.text) if artifact.text else 0
            )
            if self.enable_memory_extraction and MEMORY_AVAILABLE and artifact.text:
                logger.info("🧠 Triggering memory extraction for %s", path.name)
                asyncio.create_task(
                    self._extract_memory_safe(file_record, artifact.text),
                    name=f"memory_extract_{file_id}"
                )

            return True

        except Exception as exc:
            logger.warning("Fast text failed for %s: %s", file_id, exc)
            self.storage.update_file_stage(file_id, fast_stage=-1)
            return False

        finally:
            self.state_manager.reset_active_state()

    def _build_chunks(
        self,
        record: FileRecord,
        artifact: IngestArtifact,
    ) -> list[ChunkSnapshot]:
        """Build text chunks from the artifact."""
        text = artifact.text
        if not text or not text.strip():
            return []

        # Handle PDF with page texts
        if record.kind == "document" and record.extension == "pdf":
            page_texts = record.metadata.get("page_texts") or []
            if page_texts and isinstance(page_texts, list):
                # Build page mapping from page_texts
                combined_text = ""
                page_mapping: list[tuple[int, int, int]] = []
                for page_index, page_text in enumerate(page_texts, start=1):
                    body = (page_text or "").strip()
                    if not body:
                        continue
                    if combined_text:
                        combined_text += "\n\n"
                    start = len(combined_text)
                    combined_text += body
                    end = len(combined_text)
                    page_mapping.append((start, end, page_index))
                
                if combined_text:
                    text = combined_text
                    artifact.page_mapping = page_mapping

        chunk_tokens = settings.rag_chunk_size
        overlap_tokens = settings.rag_chunk_overlap

        payloads = self.chunker.build(
            record.id,
            text,
            page_mapping=artifact.page_mapping,
            chunk_tokens=chunk_tokens,
            overlap_tokens=overlap_tokens
        )

        now = dt.datetime.now(dt.timezone.utc)
        snapshots = []
        for payload in payloads:
            snapshots.append(ChunkSnapshot(
                chunk_id=payload.chunk_id,
                file_id=record.id,
                ordinal=payload.ordinal,
                text=payload.text,
                snippet=payload.snippet,
                token_count=payload.token_count,
                char_count=payload.char_count,
                section_path=payload.section_path,
                metadata=payload.metadata,
                created_at=now,
                version="fast",
            ))

        if not snapshots and text.strip():
            # Fallback: single chunk for entire text
            fallback_id = f"{record.id}::fast::full"
            snapshots.append(ChunkSnapshot(
                chunk_id=fallback_id,
                file_id=record.id,
                ordinal=0,
                text=text,
                snippet=text[:400],
                token_count=max(len(text) // 4, 1),
                char_count=len(text),
                section_path=None,
                metadata={},
                created_at=now,
                version="fast",
            ))

        return snapshots

    # --- Memory Extraction ---

    async def _extract_memory_safe(self, record: FileRecord, text: str) -> None:
        """Safe wrapper for memory extraction - catches all exceptions."""
        print(f"🧠 [MEMORY] _extract_memory_safe called for {record.name}")
        logger.info("🧠 _extract_memory_safe called for %s", record.name)
        try:
            await self._extract_memory(record, text)
            print(f"🧠 [MEMORY] _extract_memory completed for {record.name}")
        except Exception as exc:
            print(f"🧠 [MEMORY] Memory extraction failed for {record.path}: {exc}")
            logger.warning("Memory extraction failed for %s: %s", record.path, exc)
            import traceback
            traceback.print_exc()
            # Don't re-raise - this runs in background

    async def _extract_memory(self, record: FileRecord, text: str) -> None:
        """
        Extract memories from file content and save to database.
        Runs in background - does not block file indexing.
        """
        print(f"🧠 [MEMORY] _extract_memory started for {record.name}")

        if not MEMORY_AVAILABLE:
            print("🧠 [MEMORY] MEMORY_AVAILABLE is False, skipping")
            return

        if not text or len(text.strip()) < 100:
            print(f"🧠 [MEMORY] Text too short ({len(text.strip()) if text else 0} chars), skipping")
            return

        print(f"🧠 [MEMORY] Text length: {len(text)} chars")

        # Check if LLM is configured and available (use same endpoint as app)
        llm_url = settings.endpoints.llm
        print(f"🧠 [MEMORY] Checking LLM at {llm_url}")
        try:
            import aiohttp
            # Try health endpoint, fallback to just checking if server responds
            health_url = f"{llm_url.rstrip('/')}/health"
            async with aiohttp.ClientSession() as session:
                async with session.get(health_url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                    print(f"🧠 [MEMORY] LLM health check: {resp.status}")
        except Exception as e:
            print(f"🧠 [MEMORY] LLM not reachable: {e}, skipping")
            return

        try:
            memory_service = get_memory_service()
            now = dt.datetime.now(dt.timezone.utc).isoformat()

            # For documents, we bypass the conversation boundary detection and directly
            # create a MemCell. The ConvMemCellExtractor is designed for conversations
            # that accumulate messages over time - when history_raw_data_list is empty,
            # it returns should_end=False (waiting for more messages), which means
            # no MemCell is created for single documents.
            #
            # Instead, we directly create a MemCell for the document content.
            from services.memory.api_specs.memory_types import MemCell
            import uuid

            # Create MemCell directly for document
            # For documents, original_data contains the text content and file metadata
            # This gives the LLM more context about the document
            memcell = MemCell(
                event_id=str(uuid.uuid4()),
                user_id_list=[self.memory_user_id],
                original_data=[{
                    "content": text[:50000],  # The indexed text content
                    "file_name": record.name,
                    "file_path": str(record.path),
                    "file_type": record.kind,
                    "file_extension": record.extension,
                    "file_size_bytes": record.size,
                    "page_count": record.page_count,
                    "modified_at": record.modified_at.isoformat() if record.modified_at else None,
                    "created_at": record.created_at.isoformat() if record.created_at else None,
                    "summary": record.summary,
                }],
                timestamp=dt.datetime.now(dt.timezone.utc),
                summary=record.summary or record.name,
                group_id=None,
                participants=[],
                type=RawDataType.DOCUMENT,
            )

            print(f"🧠 [MEMORY] Created MemCell: event_id={memcell.event_id}")

            episodes_created = 0
            event_logs_created = 0
            foresights_created = 0

            # Extract episodic memory
            print(f"🧠 [MEMORY] Calling extract_memory for EPISODIC_MEMORY...")
            episode = await memory_service.memory_manager.extract_memory(
                memcell=memcell,
                memory_type=MemoryType.EPISODIC_MEMORY,
                user_id=self.memory_user_id,
            )
            print(f"🧠 [MEMORY] Episode result: {episode is not None}")

            episode_id = None
            if episode:
                episode_id = str(uuid.uuid4())
                storage_episode = StorageEpisodeRecord(
                    id=episode_id,
                    user_id=self.memory_user_id,
                    summary=getattr(episode, "summary", record.summary or ""),
                    episode=getattr(episode, "episode", ""),
                    subject=getattr(episode, "subject", record.name),
                    timestamp=now,
                    metadata={
                        "source": "file_indexer",
                        "file_id": record.id,
                        "file_name": record.name,
                        "file_path": str(record.path),
                    }
                )
                memory_service.storage.upsert_episode(storage_episode)
                episodes_created = 1
                logger.info("Created episode %s for file %s", episode_id, record.name)

                # Extract event logs
                try:
                    event_log = await memory_service.memory_manager.extract_memory(
                        memcell=memcell,
                        memory_type=MemoryType.EVENT_LOG,
                        user_id=self.memory_user_id,
                        episode_memory=episode,
                    )
                    if event_log:
                        facts = getattr(event_log, "atomic_fact", [])
                        if isinstance(facts, str):
                            facts = [facts]
                        for fact in facts:
                            if fact and fact.strip():
                                log_id = str(uuid.uuid4())
                                storage_log = StorageEventLogRecord(
                                    id=log_id,
                                    user_id=self.memory_user_id,
                                    atomic_fact=fact.strip(),
                                    timestamp=now,
                                    parent_episode_id=episode_id,
                                )
                                memory_service.storage.upsert_event_log(storage_log)
                                event_logs_created += 1
                except Exception as e:
                    logger.warning("Event log extraction failed for %s: %s", record.path, e)

                # Extract foresights
                try:
                    foresight_list = await memory_service.memory_manager.extract_memory(
                        memcell=memcell,
                        memory_type=MemoryType.FORESIGHT,
                        user_id=self.memory_user_id,
                        episode_memory=episode,
                    )
                    if foresight_list:
                        items = foresight_list if isinstance(foresight_list, list) else [foresight_list]
                        for foresight in items:
                            content = getattr(foresight, "foresight", "") or getattr(foresight, "content", "")
                            if content and content.strip():
                                fs_id = str(uuid.uuid4())
                                storage_foresight = StorageForesightRecord(
                                    id=fs_id,
                                    user_id=self.memory_user_id,
                                    content=content.strip(),
                                    evidence=getattr(foresight, "evidence", None),
                                    parent_episode_id=episode_id,
                                )
                                memory_service.storage.upsert_foresight(storage_foresight)
                                foresights_created += 1
                except Exception as e:
                    logger.warning("Foresight extraction failed for %s: %s", record.path, e)

            logger.info(
                "Memory extraction completed for %s: episodes=%d, events=%d, foresights=%d",
                record.name, episodes_created, event_logs_created, foresights_created
            )

            # Update file metadata
            record.metadata = record.metadata or {}
            record.metadata["memory_extracted"] = True
            record.metadata["memory_episode_id"] = episode_id
            record.metadata["memory_events_count"] = event_logs_created
            record.metadata["memory_foresights_count"] = foresights_created
            self.storage.upsert_file(record)

        except Exception as exc:
            logger.warning("Memory extraction failed for %s: %s", record.path, exc)
            import traceback
            traceback.print_exc()

