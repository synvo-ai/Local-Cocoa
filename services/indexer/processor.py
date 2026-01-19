"""Core processing logic for the indexer: scanning, enriching, chunking, and storing files."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import mimetypes
import random
import re
from pathlib import Path
from typing import Literal, Optional, Sequence

from services.chunker import ChunkingPipeline, ChunkPayload, chunking_pipeline
from services.llm.client import EmbeddingClient, LlmClient, TranscriptionClient
from services.core.config import settings
from services.core.content import ContentRouter, content_router
from services.core.models import (
    ChunkSnapshot,
    FailedFile,
    FileRecord,
    FolderRecord,
    IngestArtifact,
    VectorDocument,
    infer_kind,
)
from services.storage import IndexStorage
from services.vlm import VisionProcessor
from services.core.vector_store import VectorStore, get_vector_store
from . import prompts
from .scanner import checksum, fingerprint
from .state import StateManager

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

logger = logging.getLogger(__name__)


class FileProcessor:
    """Handles the end-to-end processing of a single file."""

    def __init__(
        self,
        storage: IndexStorage,
        state_manager: StateManager,
        *,
        embedding_client: EmbeddingClient,
        llm_client: LlmClient,
        transcription_client: Optional[TranscriptionClient] = None,
        content: ContentRouter = content_router,
        chunker: ChunkingPipeline = chunking_pipeline,
        vectors: Optional[VectorStore] = None,
        vision_processor: Optional[VisionProcessor] = None,
        enable_memory_extraction: bool = False,  # Enable memory extraction for files
        memory_user_id: str = "default_user",  # User ID for memory association
    ) -> None:
        self.enable_memory_extraction = enable_memory_extraction
        self.memory_user_id = memory_user_id
        self.storage = storage
        self.state_manager = state_manager
        self.embedding_client = embedding_client
        self.llm_client = llm_client
        self.transcription_client = transcription_client
        self.content_router = content
        self.chunker = chunker
        self.vector_store = vectors or get_vector_store()
        self.vision_processor = vision_processor or VisionProcessor(llm_client)

    async def process_single_file(
        self,
        folder: FolderRecord,
        path: Path,
        refresh_embeddings: bool,
        indexing_mode: Literal["fast", "deep"],
    ) -> bool:
        """Process a single file: scan -> enrich -> store."""

        # Update state via manager
        self.state_manager.active_path = path
        self.state_manager.active_started_at = dt.datetime.now(dt.timezone.utc)
        self.state_manager.active_progress = 0.0
        self.state_manager.active_kind = infer_kind(path)
        self.state_manager.active_stage = "scan"
        self.state_manager.active_detail = "Scanning file"
        self.state_manager.active_step_current = None
        self.state_manager.active_step_total = None
        self.state_manager.active_recent_events = []

        self.state_manager.set_active_stage(stage="scan", detail="Scanning file", progress=0.0, event=f"Scanning {path.name}")
        self.state_manager.set_running_progress(message=f"Indexing {path.name}")

        file_id = fingerprint(path)

        try:
            # Scan
            record, artifact = await asyncio.to_thread(self._scan_file, folder, path, indexing_mode)

            # Enrich
            self.state_manager.set_active_stage(stage="enrich", detail="Extracting text / vision", progress=self.state_manager.active_progress, event="Extracting content")
            enriched = await self._enrich_artifact(record, artifact, refresh_embeddings, indexing_mode)

            # Store
            self.state_manager.set_active_stage(stage="store", detail="Chunking + embedding + saving", progress=self.state_manager.active_progress, event="Storing chunks")
            await self._store_artifact(enriched, refresh_embeddings=refresh_embeddings)

            # Memory extraction (optional) - run in background, don't block indexing
            if self.enable_memory_extraction and MEMORY_AVAILABLE and enriched.text:
                # Fire and forget - memory extraction runs in parallel
                asyncio.create_task(
                    self._extract_memory_from_file_safe(enriched),
                    name=f"memory_extract_{file_id}"
                )

            # Mark file as successfully indexed
            self.storage.mark_file_indexed(file_id)

            return True

        except Exception as exc:
            logger.warning("Failed to process %s: %s", path, exc)
            error_reason = str(exc)

            # Mark file as error in the files table
            self.storage.mark_file_error(file_id, error_reason)

            # Also keep in folder.failed_files for backwards compatibility
            failed_file = FailedFile(path=path, reason=error_reason, timestamp=dt.datetime.now(dt.timezone.utc))
            folder.failed_files.append(failed_file)
            self.storage.upsert_folder(folder)

            self.state_manager.progress.failed += 1
            self.state_manager.progress.failed_items.append(failed_file)
            self.state_manager.set_running_progress()
            return False

        finally:
            self.state_manager.reset_active_state()

    def _scan_file(self, folder: FolderRecord, path: Path, indexing_mode: Literal["fast", "deep"] = "fast") -> tuple[FileRecord, IngestArtifact]:
        stat = path.stat()
        extension = path.suffix.lower().lstrip(".")
        file_hash = fingerprint(path)
        file_checksum = checksum(path)
        mime_type, _ = mimetypes.guess_type(str(path))

        # Skip video parsing in fast mode
        kind = infer_kind(path)
        if indexing_mode == "fast" and kind == "video":
            # Create a minimal record without parsing content
            record = FileRecord(
                id=file_hash,
                folder_id=folder.id,
                path=path,
                name=path.name,
                extension=extension,
                size=stat.st_size,
                modified_at=dt.datetime.fromtimestamp(stat.st_mtime, tz=dt.timezone.utc),
                created_at=dt.datetime.fromtimestamp(stat.st_ctime, tz=dt.timezone.utc),
                kind=kind,
                hash=file_hash,
                mime_type=mime_type,
                checksum_sha256=file_checksum,
                duration_seconds=0.0,
                page_count=0,
                summary=None,
                preview_image=None,
                metadata={"skipped_fast_mode": True},
            )
            artifact = IngestArtifact(record=record, text="", chunks=[], page_mapping=[])
            artifact.record.metadata["file_name"] = record.name
            artifact.record.metadata["name"] = record.name
            artifact.record.metadata["path"] = str(record.path)
            artifact.record.metadata["full_path"] = str(record.path)
            artifact.record.metadata["file_path"] = str(record.path)
            artifact.record.metadata["folder_id"] = record.folder_id
            artifact.record.metadata["extension"] = record.extension
            artifact.record.metadata["size"] = record.size
            artifact.record.metadata["kind"] = record.kind
            return record, artifact

        parsed = self.content_router.parse(path, indexing_mode=indexing_mode)

        record = FileRecord(
            id=file_hash,
            folder_id=folder.id,
            path=path,
            name=path.name,
            extension=extension,
            size=stat.st_size,
            modified_at=dt.datetime.fromtimestamp(stat.st_mtime, tz=dt.timezone.utc),
            created_at=dt.datetime.fromtimestamp(stat.st_ctime, tz=dt.timezone.utc),
            kind=kind,
            hash=file_hash,
            mime_type=mime_type,
            checksum_sha256=file_checksum,
            duration_seconds=parsed.duration_seconds,
            page_count=parsed.page_count,
            summary=None,
            preview_image=parsed.preview_image,
            metadata=parsed.metadata,
            # Inherit privacy level from parent folder
            privacy_level=folder.privacy_level,
        )

        artifact = IngestArtifact(record=record, text=parsed.text, chunks=[], page_mapping=parsed.page_mapping)
        artifact.record.metadata.setdefault("attachments_present", bool(parsed.attachments))
        artifact.record.metadata.update({k: v for k, v in parsed.metadata.items() if isinstance(k, str)})
        artifact.record.metadata["attachments"] = list(parsed.attachments.keys()) if parsed.attachments else []
        artifact.record.metadata["__attachments_raw"] = parsed.attachments  # kept in-memory only
        # Add essential file info to metadata for search results
        artifact.record.metadata["file_name"] = record.name
        artifact.record.metadata["name"] = record.name
        artifact.record.metadata["path"] = str(record.path)
        artifact.record.metadata["full_path"] = str(record.path)
        artifact.record.metadata["file_path"] = str(record.path)
        artifact.record.metadata["folder_id"] = record.folder_id
        artifact.record.metadata["extension"] = record.extension
        artifact.record.metadata["size"] = record.size
        artifact.record.metadata["kind"] = record.kind
        return record, artifact

    # --- Enrichment Methods ---

    async def _enrich_artifact(
        self,
        record: FileRecord,
        artifact: IngestArtifact,
        refresh_embeddings: bool,
        indexing_mode: Literal["fast", "deep"] = "fast",
    ) -> IngestArtifact:
        attachments = artifact.record.metadata.pop("__attachments_raw", {}) or {}
        text_payload = artifact.text

        # 1. Audio Transcription
        # If the parser already provided text (AudioParser), use it.
        # Otherwise, if we have audio attachments but no text, try to transcribe now.
        if record.kind == "audio":
            if text_payload and text_payload.strip():
                record.metadata["transcription_preview"] = text_payload[:512]
            else:
                audio_text = await self._process_audio_attachments(record, attachments)
                if audio_text:
                    text_payload = audio_text

        # 2. Image Vision Analysis
        image_text = await self._process_image_preview(record, indexing_mode)
        if image_text:
            text_payload = image_text

        # 3. PDF Vision Analysis
        pdf_text = await self._process_pdf_vision(record, attachments, indexing_mode)
        if pdf_text:
            text_payload = pdf_text

        # 4. Video Segment Analysis
        video_text = await self._process_video_segments(record, attachments, indexing_mode)
        if video_text:
            text_payload = video_text

        # 5. Summarization
        summary = None
        if text_payload:
            # For videos, create a summary from all segments
            if record.kind == "video" and record.metadata.get("video_segment_captions"):
                captions = record.metadata["video_segment_captions"]
                summary = "\n".join(captions[:3])  # First 3 segments
                if len(captions) > 3:
                    summary += f"\n... and {len(captions) - 3} more segments"
            else:
                summary = await self._summarize_text_for_retrieval(
                    record,
                    text_payload,
                    indexing_mode=indexing_mode,
                )
        elif record.metadata:
            summary = f"Metadata-only description for {record.name}."
        else:
            summary = f"File {record.name} located at {record.path.parent}."

        record.summary = summary.strip() if summary else None
        artifact.text = text_payload or record.summary or ""

        # 6. Chunking
        self._build_artifact_chunks(record, artifact, indexing_mode)

        # 7. Suggested Questions
        await self._generate_suggested_questions_from_chunks(record, artifact.chunks)

        return artifact

    async def _process_audio_attachments(self, record: FileRecord, attachments: dict) -> Optional[str]:
        if record.kind == "audio" and self.transcription_client and attachments.get("audio_wav"):
            try:
                transcript = await self.transcription_client.transcribe(attachments["audio_wav"])
                record.metadata["transcription_preview"] = transcript[:512]
                return transcript
            except Exception:
                pass
        return None

    async def _process_image_preview(self, record: FileRecord, indexing_mode: Literal["fast", "deep"]) -> Optional[str]:
        if record.kind == "image" and record.preview_image:
            try:
                text = await self.vision_processor.process_image(
                    record.preview_image,
                    mode=indexing_mode,
                    prompt=prompts.IMAGE_PROMPT
                )
                return text
            except Exception as e:
                logger.warning("Vision processing failed for image %s: %s", record.path, e)
                if indexing_mode == "fast" or "Tesseract" in str(e):
                    raise
        return None

    async def _process_pdf_vision(
        self,
        record: FileRecord,
        attachments: dict,
        indexing_mode: Literal["fast", "deep"]
    ) -> Optional[str]:
        if not (record.kind == "document" and record.extension == "pdf" and (settings.pdf_mode == "vision" or indexing_mode == "deep")):
            return None

        if not attachments:
            return None

        page_images = {k: v for k, v in attachments.items() if k.startswith("page_")}
        if not page_images:
            return None

        try:
            sorted_pages = sorted(page_images.items(), key=lambda x: int(x[0].split("_")[1]))
            total_pages = len(sorted_pages)

            stage_name = "pdf_text" if indexing_mode == "fast" else "pdf_vision"
            page_results = []

            for i, (page_key, image_bytes) in enumerate(sorted_pages):
                self.state_manager.set_active_stage(
                    stage=stage_name,
                    detail=f"Processing page {i + 1}/{total_pages}",
                    step_current=i + 1,
                    step_total=total_pages,
                    progress=((i) / max(total_pages, 1)) * 100,
                )
                page_num = int(page_key.split("_")[1])

                if settings.vision_batch_delay_ms > 0 and i > 0:
                    await asyncio.sleep(settings.vision_batch_delay_ms / 1000)

                prompt = prompts.PDF_PAGE_PROMPT if indexing_mode == "deep" else ""

                result = await self.vision_processor.process_image(
                    image_bytes,
                    mode=indexing_mode,
                    prompt=prompt
                )

                cleaned = (result or "").strip()
                if cleaned.startswith("```"):
                    cleaned = re.sub(r"^```\w*\s+|\s+```$", "", cleaned, flags=re.MULTILINE).strip()

                page_texts = record.metadata.get("page_texts") or []
                raw_text = ""
                if isinstance(page_texts, list) and 0 <= page_num - 1 < len(page_texts):
                    raw_text = (page_texts[page_num - 1] or "").strip()

                if not cleaned and raw_text:
                    cleaned = raw_text

                if cleaned:
                    page_results.append(cleaned)
                    self.state_manager.set_active_stage(
                        stage=stage_name,
                        detail=f"Processed page {i + 1}/{total_pages}",
                        step_current=i + 1,
                        step_total=total_pages,
                        progress=((i + 1) / max(total_pages, 1)) * 100,
                        event=f"Page {i + 1}: {cleaned[:180]}",
                        event_payload={"page": i + 1},
                    )
                else:
                    page_results.append(f"[Page {page_num} - no content extracted]")
                    # For brevity, implementing warning reporting inline or simplifying
                    self.state_manager.set_active_stage(
                        stage=stage_name,
                        detail=f"Processed page {page_num}/{total_pages}",
                        step_current=page_num,
                        step_total=total_pages,
                        progress=((page_num) / max(total_pages, 1)) * 100,
                        event=f"Page {page_num}: no content extracted",
                        event_type="warn",
                    )

            if page_results:
                record.metadata["pdf_page_descriptions"] = page_results
                record.metadata["pdf_vision_mode"] = indexing_mode
                return "\n\n".join(page_results)

        except Exception as exc:
            logger.warning("Failed to process PDF pages: %s", exc)
            if indexing_mode == "fast" or "Tesseract" in str(exc):
                raise
        return None

    async def _process_video_segments(
        self,
        record: FileRecord,
        attachments: dict,
        indexing_mode: Literal["fast", "deep"]
    ) -> Optional[str]:
        if record.kind != "video":
            return None

        if not settings.endpoints.vision:
            return None

        if not attachments.get("video_segments"):
            return None

        if indexing_mode == "fast":
            return None

        video_segments = attachments["video_segments"]
        segment_captions = []
        total_segments = len(video_segments)

        for i, segment in enumerate(video_segments):
            try:
                self.state_manager.set_active_stage(
                    stage="video_vision",
                    detail=f"Processing segment {i + 1}/{total_segments}",
                    step_current=i + 1,
                    step_total=total_segments,
                    progress=((i) / max(total_segments, 1)) * 100,
                )

                caption = await self.llm_client.describe_video_segment(
                    frames=segment["frames"],
                    start_time=segment["start_time"],
                    end_time=segment["end_time"],
                    prompt=prompts.VIDEO_SEGMENT_PROMPT
                )
                if caption:
                    segment_captions.append(caption)
                    self.state_manager.set_active_stage(
                        stage="video_vision",
                        detail=f"Processed segment {i + 1}/{total_segments}",
                        step_current=i + 1,
                        step_total=total_segments,
                        progress=((i + 1) / max(total_segments, 1)) * 100,
                        event=f"Segment {i + 1}: {caption[:100]}...",
                    )
            except Exception as exc:
                logger.warning("Failed to process video segment %d of %s: %s", i + 1, record.path, exc)

        if segment_captions:
            record.metadata["video_segment_captions"] = segment_captions
            return "\n".join(segment_captions)

        return None

    async def _summarize_text_for_retrieval(
        self,
        record: FileRecord,
        text_payload: str,
        *,
        indexing_mode: Literal["fast", "deep"],
    ) -> str:
        if not text_payload.strip():
            return ""

        if indexing_mode == "fast":
            return text_payload.strip()[:2000]

        metadata_block = self._format_file_metadata_for_llm(record, indexing_mode=indexing_mode)
        limit = settings.summary_input_max_chars
        truncated_content = text_payload.strip()[:limit]
        if len(text_payload) > limit:
            truncated_content += "\n...[content truncated]..."

        prompt = f"{metadata_block}\n\nContent:\n{truncated_content}"

        try:
            messages = [
                {"role": "system", "content": prompts.DEFAULT_SUMMARY_PROMPT},
                {"role": "user", "content": prompt},
            ]
            summary = await self.llm_client.chat_complete(
                messages,
                max_tokens=max(int(getattr(settings, "summary_max_tokens", 256)), 32),
                temperature=0.2,
            )
            cleaned = (summary or "").strip()
            if cleaned:
                return cleaned
        except Exception as exc:
            logger.warning("LLM summarisation failed for %s: %s", record.path, exc)

        # Fallback
        return text_payload.strip()[:2000]

    def _format_file_metadata_for_llm(self, record: FileRecord, *, indexing_mode: Literal["fast", "deep"]) -> str:
        modified = record.modified_at.isoformat() if record.modified_at else "unknown"
        created = record.created_at.isoformat() if record.created_at else "unknown"
        size = str(record.size) if record.size is not None else "unknown"
        mode_label = "fast (OCR/text-only)" if indexing_mode == "fast" else "deep (vision -> text)"
        return "\n".join(
            [
                f"Indexing mode: {mode_label}",
                f"File name: {record.name}",
                f"Path: {record.path}",
                f"Kind: {record.kind}",
                f"Extension: {record.extension}",
                f"Size bytes: {size}",
                f"Modified at: {modified}",
                f"Created at: {created}",
            ]
        )

    # --- Question Generation ---

    async def _generate_suggested_questions_from_chunks(
        self, record: FileRecord, chunks: Optional[list[ChunkSnapshot]] = None
    ) -> None:
        if record.kind not in ("document", "presentation", "spreadsheet"):
            return

        if not chunks or len(chunks) == 0:
            return

        try:
            meaningful_chunks = [c for c in chunks if len(c.text.strip()) >= 100]
            if not meaningful_chunks:
                meaningful_chunks = chunks

            num_to_select = min(4, len(meaningful_chunks))
            selected_chunks = random.sample(meaningful_chunks, num_to_select)

            all_questions: list[str] = []

            for chunk in selected_chunks:
                chunk_text = chunk.text.strip()[:1500]

                question_text = await self.llm_client.complete(
                    system=prompts.CHUNK_QUESTIONS_PROMPT,
                    prompt=chunk_text,
                    max_tokens=50,
                )

                q = question_text.strip()
                q = q.strip().lstrip("- ").strip()
                q = re.sub(r'^[\d]+[.\)]\s*', '', q).strip()
                if "\n" in q:
                    q = q.split("\n")[0].strip()
                if "?" in q:
                    q = q[:q.index("?") + 1]

                if q and "?" in q and 10 < len(q) < 120:
                    all_questions.append(q)

            unique_questions = list(dict.fromkeys(all_questions))[:4]
            if unique_questions:
                record.metadata["suggested_questions"] = unique_questions

        except Exception as e:
            logger.warning("Failed to generate suggested questions for %s: %s", record.path, e)

    # --- Storage & Embeddings ---

    async def _store_artifact(self, artifact: IngestArtifact, *, refresh_embeddings: bool) -> None:
        existing = self.storage.get_file(artifact.record.id)
        previous_chunk_ids = (
            existing.metadata.get("vector_chunks")
            if existing and isinstance(existing.metadata, dict)
            else []
        )

        reuse_vectors = (
            existing is not None
            and existing.checksum_sha256 == artifact.record.checksum_sha256
            and existing.embedding_vector is not None
            and bool(previous_chunk_ids)
            and settings.reuse_embeddings
            and not refresh_embeddings
            and isinstance(existing.metadata, dict)
            and existing.metadata.get("chunk_strategy") == artifact.record.metadata.get("chunk_strategy")
        )

        if reuse_vectors:
            artifact.record.metadata.setdefault("vector_chunks", previous_chunk_ids)
            artifact.record.embedding_vector = existing.embedding_vector
            artifact.record.embedding_determined_at = existing.embedding_determined_at
            artifact.record.summary = existing.summary
            artifact.record.preview_image = artifact.record.preview_image or existing.preview_image
            artifact.record.index_status = "indexed"
            artifact.record.error_reason = None
            artifact.record.error_at = None
            self.storage.upsert_file(artifact.record)
            return

        chunk_snapshots = artifact.chunks or []
        try:
            vectors = await self._embed_chunks(chunk_snapshots)
        except Exception as exc:
            logger.warning("Embedding failed for %s: %s", artifact.record.path, exc)
            vectors = []
        now = dt.datetime.now(dt.timezone.utc)

        documents: list[VectorDocument] = []
        for chunk, vector in zip(chunk_snapshots, vectors):
            doc_metadata = {
                "chunk_id": chunk.chunk_id,
                "file_id": artifact.record.id,
                "file_name": artifact.record.name,
                "name": artifact.record.name,
                "path": str(artifact.record.path),
                "full_path": str(artifact.record.path),
                "folder_id": artifact.record.folder_id,
                "extension": artifact.record.extension,
                "size": artifact.record.size,
                "modified_at": artifact.record.modified_at.isoformat() if artifact.record.modified_at else None,
                "created_at": artifact.record.created_at.isoformat() if artifact.record.created_at else None,
                "summary": artifact.record.summary,
                "snippet": chunk.snippet,
                "kind": artifact.record.kind,
                "section_path": chunk.section_path,
                "token_count": chunk.token_count,
                "char_count": chunk.char_count,
                "chunk_metadata": chunk.metadata,
                # Privacy level for filtering - external requests cannot see private files
                "privacy_level": artifact.record.privacy_level,
            }
            if chunk.metadata:
                page_info_keys = ["page_number", "page_numbers", "page_start", "page_end", "pdf_vision_mode"]
                for key in page_info_keys:
                    if key in chunk.metadata and key not in doc_metadata:
                        doc_metadata[key] = chunk.metadata[key]
                if "page_number" in chunk.metadata:
                    doc_metadata["page"] = chunk.metadata["page_number"]
            documents.append(
                VectorDocument(
                    doc_id=chunk.chunk_id,
                    vector=vector,
                    metadata=doc_metadata,
                )
            )

        if previous_chunk_ids:
            try:
                self.vector_store.delete(previous_chunk_ids)
            except Exception as exc:
                logger.warning("Failed to delete previous vectors for %s: %s", artifact.record.id, exc)
        if documents:
            try:
                self.vector_store.upsert(documents)
                self.vector_store.flush()
            except Exception as exc:
                logger.warning("Vector store upsert failed for %s: %s", artifact.record.id, exc)
                documents = []

        artifact.record.metadata["vector_chunks"] = [doc.doc_id for doc in documents]
        if vectors:
            artifact.record.embedding_vector = vectors[0]
            artifact.record.embedding_determined_at = now

        artifact.record.index_status = "indexed"
        artifact.record.error_reason = None
        artifact.record.error_at = None

        self.storage.upsert_file(artifact.record)
        self.storage.replace_chunks(artifact.record.id, chunk_snapshots)

    async def _embed_chunks(self, chunks: Sequence[ChunkSnapshot]) -> list[list[float]]:
        chunk_payloads = [(chunk, chunk.text.strip()) for chunk in chunks]
        chunk_payloads = [(chunk, text) for chunk, text in chunk_payloads if text]
        if not chunk_payloads:
            return []

        batch_size = max(settings.embed_batch_size, 1)
        delay_seconds = settings.embed_batch_delay_ms / 1000 if settings.embed_batch_delay_ms else 0.0
        vectors: list[list[float]] = []

        max_chars = settings.embed_max_chars

        total_batches = (len(chunk_payloads) + batch_size - 1) // batch_size
        for batch_index, start in enumerate(range(0, len(chunk_payloads), batch_size), start=1):
            batch = chunk_payloads[start:start + batch_size]
            texts = [text[:max_chars] for _, text in batch]

            current_progress = ((batch_index - 1) / max(total_batches, 1)) * 100

            self.state_manager.set_active_stage(
                stage="embed",
                detail=f"Embedding batch {batch_index}/{max(total_batches, 1)}",
                step_current=batch_index,
                step_total=total_batches,
                progress=current_progress,
            )
            response_vectors = await self.embedding_client.encode(texts)
            if len(response_vectors) != len(batch):
                raise RuntimeError(
                    f"Embedding service returned {len(response_vectors)} vectors for batch of {len(batch)} chunks"
                )
            vectors.extend(response_vectors)

            completed_progress = (batch_index / max(total_batches, 1)) * 100

            self.state_manager.set_active_stage(
                stage="embed",
                detail=f"Embedded {len(vectors)}/{len(chunk_payloads)} chunks",
                step_current=batch_index,
                step_total=total_batches,
                progress=completed_progress,
                event=f"Embedded {len(vectors)} chunks",
            )
            if delay_seconds > 0 and start + batch_size < len(chunk_payloads):
                await asyncio.sleep(delay_seconds)

        return vectors

    # --- Chunking Helpers ---

    def _build_artifact_chunks(
        self,
        record: FileRecord,
        artifact: IngestArtifact,
        indexing_mode: Literal["fast", "deep"]
    ) -> None:
        if record.kind == "video" and record.metadata.get("video_segment_captions"):
            artifact.chunks = self._build_video_chunk_snapshots(record, record.metadata["video_segment_captions"])
            record.metadata["chunk_strategy"] = "video_segments_v1"
        elif record.kind == "document" and record.extension == "pdf" and record.metadata.get("pdf_page_descriptions"):
            page_descriptions = record.metadata["pdf_page_descriptions"]
            if settings.pdf_one_chunk_per_page:
                artifact.chunks = self._build_pdf_page_chunk_snapshots(record, page_descriptions, is_vision=True)
                record.metadata["chunk_strategy"] = f"pdf_vision_pages_v2_{indexing_mode}"
            else:
                artifact.chunks = self._build_pdf_multi_chunk_snapshots_from_pages(
                    record,
                    page_descriptions,
                    indexing_mode=indexing_mode,
                )
                record.metadata["chunk_strategy"] = f"pdf_vision_multi_v1_{indexing_mode}"

        elif record.kind == "document" and record.extension == "pdf":
            page_texts = record.metadata.get("page_texts") or []

            if (not page_texts) and artifact.page_mapping and artifact.text:
                try:
                    sorted_mapping = sorted(artifact.page_mapping, key=lambda x: x[2])
                    if sorted_mapping:
                        max_page = sorted_mapping[-1][2]
                        mapping_dict = {m[2]: (m[0], m[1]) for m in sorted_mapping}
                        reconstructed: list[str] = []
                        for page_num in range(1, max_page + 1):
                            if page_num in mapping_dict:
                                start, end = mapping_dict[page_num]
                                reconstructed.append(artifact.text[start:end])
                            else:
                                reconstructed.append("")
                        if any((t or "").strip() for t in reconstructed):
                            page_texts = reconstructed
                            record.metadata["page_texts"] = page_texts
                except Exception:
                    pass

            if isinstance(page_texts, list) and any((t or "").strip() for t in page_texts):
                if settings.pdf_one_chunk_per_page:
                    artifact.chunks = self._build_pdf_page_chunk_snapshots(record, page_texts, is_vision=False)
                    record.metadata["chunk_strategy"] = "pdf_text_pages_v2"
                else:
                    if artifact.page_mapping and artifact.text.strip():
                        artifact.chunks = self._build_chunk_snapshots(
                            record,
                            artifact.text,
                            page_mapping=artifact.page_mapping,
                            indexing_mode=indexing_mode,
                        )
                    else:
                        artifact.chunks = self._build_pdf_multi_chunk_snapshots_from_pages(
                            record,
                            page_texts,
                            indexing_mode=indexing_mode,
                        )
                    record.metadata["chunk_strategy"] = f"pdf_text_multi_v1_{indexing_mode}"
            else:
                if artifact.text.strip():
                    artifact.chunks = self._build_chunk_snapshots(
                        record,
                        artifact.text,
                        page_mapping=artifact.page_mapping,
                        indexing_mode=indexing_mode
                    )
                    record.metadata["chunk_strategy"] = f"chunker_v1_{indexing_mode}"
                else:
                    artifact.chunks = []
                    record.metadata["chunk_strategy"] = "pdf_empty_text"
        else:
            artifact.chunks = self._build_chunk_snapshots(
                record,
                artifact.text,
                page_mapping=artifact.page_mapping,
                indexing_mode=indexing_mode
            )
            record.metadata["chunk_strategy"] = f"chunker_v1_{indexing_mode}"

    def _build_chunk_snapshots(
        self,
        record: FileRecord,
        text: str,
        page_mapping: list[tuple[int, int, int]] = None,
        indexing_mode: Literal["fast", "deep"] = "fast"
    ) -> list[ChunkSnapshot]:
        if not text:
            return []

        chunk_tokens = settings.rag_chunk_size
        overlap_tokens = settings.rag_chunk_overlap

        payloads = self.chunker.build(
            record.id,
            text,
            page_mapping=page_mapping,
            chunk_tokens=chunk_tokens,
            overlap_tokens=overlap_tokens
        )
        snapshots = [self._to_snapshot(record.id, payload) for payload in payloads]
        if snapshots:
            return snapshots

        now = dt.datetime.now(dt.timezone.utc)
        fallback_id = f"{record.id}::full"
        return [
            ChunkSnapshot(
                chunk_id=fallback_id,
                file_id=record.id,
                ordinal=0,
                text=text,
                snippet=text[:400],
                token_count=max(len(text) // self.chunker.char_ratio, 1),
                char_count=len(text),
                section_path=None,
                metadata={},
                created_at=now,
            )
        ]

    def _build_video_chunk_snapshots(self, record: FileRecord, segment_captions: list[str]) -> list[ChunkSnapshot]:
        if not segment_captions:
            return []

        now = dt.datetime.now(dt.timezone.utc)
        chunks = []

        for ordinal, caption in enumerate(segment_captions):
            chunk_id = f"{record.id}::segment_{ordinal}"
            snippet = caption[:1600] if len(caption) > 1600 else caption

            chunks.append(
                ChunkSnapshot(
                    chunk_id=chunk_id,
                    file_id=record.id,
                    ordinal=ordinal,
                    text=caption,
                    snippet=snippet,
                    token_count=max(len(caption) // self.chunker.char_ratio, 1),
                    char_count=len(caption),
                    section_path=f"segment_{ordinal}",
                    metadata={"segment_index": ordinal},
                    created_at=now,
                )
            )

        return chunks

    def _build_pdf_page_chunk_snapshots(self, record: FileRecord, page_descriptions: list[str], is_vision: bool = True) -> list[ChunkSnapshot]:
        if not page_descriptions:
            return []

        now = dt.datetime.now(dt.timezone.utc)
        snapshots: list[ChunkSnapshot] = []

        for page_index, page_text in enumerate(page_descriptions, start=1):
            cleaned = (page_text or "").strip()
            if not cleaned:
                cleaned = f"[Page {page_index} - no content extracted]"

            ordinal = page_index - 1
            section_path = f"page_{page_index}"
            chunk_id = self._chunk_id_for_section(record.id, ordinal, section_path)
            snippet = cleaned[:1600]

            metadata = {
                "page_numbers": [page_index],
                "page_start": page_index,
                "page_end": page_index,
                "page_number": page_index,
                "pdf_vision_mode": is_vision,
                "section_path": section_path,
            }

            snapshots.append(
                ChunkSnapshot(
                    chunk_id=chunk_id,
                    file_id=record.id,
                    ordinal=ordinal,
                    text=cleaned,
                    snippet=snippet,
                    token_count=max(len(cleaned) // 4, 1),
                    char_count=len(cleaned),
                    section_path=section_path,
                    metadata=metadata,
                    created_at=now,
                )
            )

        return snapshots

    def _build_pdf_multi_chunk_snapshots_from_pages(
        self,
        record: FileRecord,
        page_texts: list[str],
        *,
        indexing_mode: Literal["fast", "deep"],
    ) -> list[ChunkSnapshot]:
        if not page_texts:
            return []

        # Logic unified: "deep" mode now also uses the continuous text construction below
        # to allow chunks to span page boundaries (e.g. sentences crossing pages).

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

        return self._build_chunk_snapshots(
            record,
            combined_text,
            page_mapping=page_mapping,
            indexing_mode=indexing_mode,
        )

    @staticmethod
    def _chunk_id_for_section(file_id: str, ordinal: int, section_path: Optional[str], sub_index: Optional[int] = None) -> str:
        import xxhash
        key = f"{file_id}:{ordinal}:{section_path or 'root'}"
        if sub_index is not None:
            key += f":{sub_index}"
        digest = xxhash.xxh64()
        digest.update(key.encode('utf-8'))
        return digest.hexdigest()

    @staticmethod
    def _to_snapshot(file_id: str, payload: ChunkPayload) -> ChunkSnapshot:
        return ChunkSnapshot(
            chunk_id=payload.chunk_id,
            file_id=file_id,
            ordinal=payload.ordinal,
            text=payload.text,
            snippet=payload.snippet,
            token_count=payload.token_count,
            char_count=payload.char_count,
            section_path=payload.section_path,
            metadata=payload.metadata,
            created_at=payload.created_at,
        )

    # --- Memory Extraction ---

    async def _extract_memory_from_file_safe(self, artifact: IngestArtifact) -> None:
        """Safe wrapper for memory extraction - catches all exceptions."""
        try:
            await self._extract_memory_from_file(artifact)
        except Exception as exc:
            logger.warning("Memory extraction failed for %s: %s", artifact.record.path, exc)
            # Don't re-raise - this runs in background and shouldn't affect anything

    async def _extract_memory_from_file(self, artifact: IngestArtifact) -> None:
        """
        Extract memories (episodes, foresights, event logs) from file content
        and save them to the database.

        This integrates the Memory system with file indexing, allowing automatic
        extraction of structured memories from uploaded documents.
        Runs in background - does not block file indexing.
        """
        if not MEMORY_AVAILABLE:
            logger.debug("Memory module not available, skipping extraction")
            return

        record = artifact.record
        text = artifact.text

        if not text or len(text.strip()) < 100:
            logger.debug("Skipping memory extraction for %s: text too short", record.path)
            return

        # Check if LLM is configured and available (use same endpoint as app)
        import aiohttp
        llm_url = settings.endpoints.llm
        try:
            health_url = f"{llm_url.rstrip('/')}/health"
            async with aiohttp.ClientSession() as session:
                async with session.get(health_url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                    # Accept any response as "available" - some LLM servers return 404 for /health but work fine
                    pass
        except Exception as e:
            logger.debug("LLM service not reachable at %s (%s), skipping memory extraction", llm_url, e)
            return

        try:
            memory_service = get_memory_service()
            now = dt.datetime.now(dt.timezone.utc).isoformat()

            # Prepare document content as RawData
            raw_data = RawData(
                content={
                    "text": text[:50000],  # Limit text length for LLM processing
                    "file_name": record.name,
                    "file_path": str(record.path),
                    "file_type": record.kind,
                    "summary": record.summary or "",
                    "metadata": record.metadata or {},
                },
                data_id=record.id,
                data_type="document",
                metadata={
                    "source": "file_indexer",
                    "file_id": record.id,
                    "folder_id": record.folder_id,
                    "extension": record.extension,
                    "size": record.size,
                }
            )

            # Extract memcell first
            memcell, status = await memory_service.memory_manager.extract_memcell(
                history_raw_data_list=[],
                new_raw_data_list=[raw_data],
                raw_data_type=RawDataType.DOCUMENT,
                group_id=None,
                group_name=None,
                user_id_list=[self.memory_user_id],
            )

            if not memcell:
                logger.debug("No memcell extracted for %s", record.path)
                return

            episodes_created = 0
            event_logs_created = 0
            foresights_created = 0

            # Extract episodic memory
            episode = await memory_service.memory_manager.extract_memory(
                memcell=memcell,
                memory_type=MemoryType.EPISODIC_MEMORY,
                user_id=self.memory_user_id,
            )

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

            # Update file metadata to indicate memory was extracted
            record.metadata["memory_extracted"] = True
            record.metadata["memory_episode_id"] = episode_id
            record.metadata["memory_events_count"] = event_logs_created
            record.metadata["memory_foresights_count"] = foresights_created
            self.storage.upsert_file(record)

        except Exception as exc:
            logger.warning("Memory extraction failed for %s: %s", record.path, exc)
            import traceback
            traceback.print_exc()
            raise
