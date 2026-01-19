"""Deep Processor - Round 2.

Uses VLM (Vision Language Model) for deeper understanding of visual content.
Produces additional chunks (v2) that complement fast text extraction.
VLM text extraction + embedding happen together since VLM is already slow.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import re
from typing import Optional

from services.chunker import ChunkingPipeline, chunking_pipeline
from services.core.config import settings
from services.core.models import ChunkSnapshot, FileRecord, VectorDocument
from services.llm.client import EmbeddingClient, LlmClient
from services.storage import IndexStorage
from services.vlm import VisionProcessor
from services.core.vector_store import VectorStore, get_vector_store
from ..state import StateManager
from .. import prompts

logger = logging.getLogger(__name__)


class DeepProcessor:
    """Round 2: Deep vision-based processing.
    
    Responsibilities:
    - Use VLM to extract richer descriptions from images/PDFs
    - Generate chunks_v2 (deep version)
    - Generate embeddings for deep chunks
    - Store in both SQLite and Qdrant
    - Update deep_stage from 0 -> 2 (text+embed together)
    
    Only processes files that would benefit from VLM:
    - Images
    - PDFs with visual content
    - Presentations with images
    
    Skips:
    - Plain text files
    - Audio/video (handled separately)
    - Files already processed by deep
    """

    def __init__(
        self,
        storage: IndexStorage,
        state_manager: StateManager,
        *,
        embedding_client: EmbeddingClient,
        llm_client: LlmClient,
        chunker: ChunkingPipeline = chunking_pipeline,
        vectors: Optional[VectorStore] = None,
        vision_processor: Optional[VisionProcessor] = None,
    ) -> None:
        self.storage = storage
        self.state_manager = state_manager
        self.embedding_client = embedding_client
        self.llm_client = llm_client
        self.chunker = chunker
        self.vector_store = vectors or get_vector_store()
        self.vision_processor = vision_processor or VisionProcessor(llm_client)

    async def process(self, file_id: str) -> bool:
        """Process a single file with VLM for deep understanding.
        
        Args:
            file_id: The file ID to process
            
        Returns:
            True if successful, False otherwise
        """
        file_record = self.storage.get_file(file_id)
        if not file_record:
            logger.warning("File not found: %s", file_id)
            return False

        # Must have completed fast round first
        if file_record.fast_stage < 2:
            logger.warning("File %s hasn't completed fast round yet", file_id)
            return False

        if file_record.deep_stage >= 2:
            logger.debug("File %s already has deep_stage >= 2, skipping", file_id)
            return True

        if file_record.deep_stage == -2:
            logger.debug("File %s was marked as skipped for deep", file_id)
            return True

        # Check if this file type benefits from VLM
        if not self._should_process_deep(file_record):
            logger.info("Skipping deep processing for %s (not suitable)", file_record.name)
            self.storage.update_file_stage(file_id, deep_stage=-2)  # -2 = skipped
            return True

        path = file_record.path
        if not path.exists():
            logger.warning("File path does not exist: %s", path)
            self.storage.update_file_stage(file_id, deep_stage=-1)
            return False

        try:
            self.state_manager.set_active_stage(
                stage="deep_vision",
                detail=f"Deep processing {path.name}",
                progress=0.0,
                event=f"VLM analyzing {path.name}"
            )

            # Get deep text based on file type
            deep_text = None
            deep_chunks: list[ChunkSnapshot] = []

            if file_record.kind == "image":
                deep_text = await self._process_image(file_record)
            elif file_record.kind == "document" and file_record.extension == "pdf":
                deep_text, deep_chunks = await self._process_pdf(file_record)
            elif file_record.kind == "presentation":
                deep_text = await self._process_presentation(file_record)

            if not deep_text and not deep_chunks:
                logger.info("No deep content extracted for %s", file_record.name)
                now = dt.datetime.now(dt.timezone.utc)
                self.storage.update_file_stage(
                    file_id,
                    deep_stage=2,
                    deep_text_at=now,
                    deep_embed_at=now
                )
                return True

            # If we got text but no chunks, build chunks
            if deep_text and not deep_chunks:
                deep_chunks = self._build_deep_chunks(file_record, deep_text)

            # Set version to "deep" for all chunks
            for chunk in deep_chunks:
                chunk.version = "deep"

            # Store chunks in SQLite
            self.storage.replace_chunks(file_id, deep_chunks, version="deep")

            # Generate embeddings for deep chunks
            now = dt.datetime.now(dt.timezone.utc)
            if deep_chunks:
                self.state_manager.set_active_stage(
                    stage="deep_embed",
                    detail=f"Embedding {len(deep_chunks)} deep chunks",
                    progress=50.0,
                )

                vectors = await self._embed_chunks(deep_chunks)
                
                # Store in vector database
                documents: list[VectorDocument] = []
                for chunk, vector in zip(deep_chunks, vectors):
                    doc_metadata = {
                        "chunk_id": chunk.chunk_id,
                        "file_id": file_record.id,
                        "file_name": file_record.name,
                        "path": str(file_record.path),
                        "folder_id": file_record.folder_id,
                        "extension": file_record.extension,
                        "kind": file_record.kind,
                        "snippet": chunk.snippet,
                        "version": "deep",
                        # Privacy level for filtering - external requests cannot see private files
                        "privacy_level": file_record.privacy_level,
                    }
                    if chunk.metadata:
                        for key in ["page_number", "page_numbers"]:
                            if key in chunk.metadata:
                                doc_metadata[key] = chunk.metadata[key]
                    
                    documents.append(VectorDocument(
                        doc_id=chunk.chunk_id,
                        vector=vector,
                        metadata=doc_metadata,
                    ))

                if documents:
                    try:
                        self.vector_store.upsert(documents)
                        self.vector_store.flush()
                    except Exception as exc:
                        logger.warning("Vector store upsert failed for deep chunks: %s", exc)

                # Update file metadata
                file_record.metadata = file_record.metadata or {}
                file_record.metadata["vector_chunks_deep"] = [d.doc_id for d in documents]
                file_record.metadata["chunk_count_deep"] = len(deep_chunks)
                file_record.metadata["deep_processed"] = True

            # Update stage
            file_record.deep_stage = 2
            file_record.deep_text_at = now
            file_record.deep_embed_at = now
            self.storage.upsert_file(file_record)

            logger.info(
                "Deep processing completed for %s: %d chunks",
                file_record.name, len(deep_chunks)
            )
            return True

        except Exception as exc:
            logger.warning("Deep processing failed for %s: %s", file_id, exc)
            self.storage.update_file_stage(file_id, deep_stage=-1)
            return False

        finally:
            self.state_manager.reset_active_state()

    def _should_process_deep(self, file_record: FileRecord) -> bool:
        """Determine if a file would benefit from VLM processing."""
        # Images always benefit from VLM
        if file_record.kind == "image":
            return True

        # PDFs with pages benefit from VLM
        if file_record.kind == "document" and file_record.extension == "pdf":
            # Check if we have page images or preview
            if file_record.preview_image:
                return True
            page_count = file_record.page_count or 0
            if page_count > 0:
                return True

        # Presentations with images
        if file_record.kind == "presentation":
            return True

        # Skip text-only files
        if file_record.kind in ("document",) and file_record.extension in ("txt", "md", "csv"):
            return False

        # Skip audio/video (handled separately)
        if file_record.kind in ("audio", "video"):
            return False

        return False

    async def _process_image(self, record: FileRecord) -> Optional[str]:
        """Process image using VLM."""
        if not record.preview_image:
            # Try to read the image file
            try:
                with open(record.path, "rb") as f:
                    image_bytes = f.read()
            except Exception:
                return None
        else:
            image_bytes = record.preview_image

        try:
            text = await self.vision_processor.process_image(
                image_bytes,
                mode="deep",
                prompt=prompts.IMAGE_PROMPT
            )
            return text
        except Exception as e:
            logger.warning("VLM processing failed for image %s: %s", record.path, e)
            return None

    async def _process_pdf(self, record: FileRecord) -> tuple[Optional[str], list[ChunkSnapshot]]:
        """Process PDF pages using VLM."""
        # We need to re-parse to get page images
        from services.core.content import content_router
        
        try:
            parsed = await asyncio.to_thread(
                content_router.parse, record.path, indexing_mode="deep"
            )
        except Exception as e:
            logger.warning("Failed to parse PDF for deep processing: %s", e)
            return None, []

        attachments = parsed.attachments or {}
        page_images = {k: v for k, v in attachments.items() if k.startswith("page_")}
        
        if not page_images:
            return None, []

        sorted_pages = sorted(page_images.items(), key=lambda x: int(x[0].split("_")[1]))
        total_pages = len(sorted_pages)
        page_results: list[str] = []
        chunks: list[ChunkSnapshot] = []
        now = dt.datetime.now(dt.timezone.utc)

        for i, (page_key, image_bytes) in enumerate(sorted_pages):
            self.state_manager.set_active_stage(
                stage="deep_vision",
                detail=f"VLM processing page {i + 1}/{total_pages}",
                step_current=i + 1,
                step_total=total_pages,
                progress=((i) / max(total_pages, 1)) * 50,  # 0-50% for VLM
            )

            page_num = int(page_key.split("_")[1])

            if settings.vision_batch_delay_ms > 0 and i > 0:
                await asyncio.sleep(settings.vision_batch_delay_ms / 1000)

            try:
                result = await self.vision_processor.process_image(
                    image_bytes,
                    mode="deep",
                    prompt=prompts.PDF_PAGE_PROMPT
                )

                cleaned = (result or "").strip()
                if cleaned.startswith("```"):
                    cleaned = re.sub(r"^```\w*\s+|\s+```$", "", cleaned, flags=re.MULTILINE).strip()

                if cleaned:
                    page_results.append(cleaned)
                    
                    # Create a chunk for this page
                    chunk_id = f"{record.id}::deep::page_{page_num}"
                    chunks.append(ChunkSnapshot(
                        chunk_id=chunk_id,
                        file_id=record.id,
                        ordinal=page_num - 1,
                        text=cleaned,
                        snippet=cleaned[:400],
                        token_count=max(len(cleaned) // 4, 1),
                        char_count=len(cleaned),
                        section_path=f"page_{page_num}",
                        metadata={
                            "page_number": page_num,
                            "page_numbers": [page_num],
                            "source": "vlm",
                        },
                        created_at=now,
                        version="deep",
                    ))

            except Exception as e:
                logger.warning("VLM failed for page %d of %s: %s", page_num, record.path, e)

        combined_text = "\n\n".join(page_results) if page_results else None
        return combined_text, chunks

    async def _process_presentation(self, record: FileRecord) -> Optional[str]:
        """Process presentation slides using VLM."""
        # Similar to image processing
        if record.preview_image:
            try:
                text = await self.vision_processor.process_image(
                    record.preview_image,
                    mode="deep",
                    prompt="Describe this presentation slide in detail."
                )
                return text
            except Exception as e:
                logger.warning("VLM processing failed for presentation %s: %s", record.path, e)
        return None

    def _build_deep_chunks(self, record: FileRecord, text: str) -> list[ChunkSnapshot]:
        """Build chunks from deep text extraction."""
        if not text or not text.strip():
            return []

        now = dt.datetime.now(dt.timezone.utc)
        chunk_id = f"{record.id}::deep::full"
        
        return [ChunkSnapshot(
            chunk_id=chunk_id,
            file_id=record.id,
            ordinal=0,
            text=text,
            snippet=text[:400],
            token_count=max(len(text) // 4, 1),
            char_count=len(text),
            section_path=None,
            metadata={"source": "vlm"},
            created_at=now,
            version="deep",
        )]

    async def _embed_chunks(self, chunks: list[ChunkSnapshot]) -> list[list[float]]:
        """Generate embeddings for chunks."""
        texts = [c.text.strip()[:settings.embed_max_chars] for c in chunks if c.text.strip()]
        if not texts:
            return []

        batch_size = max(settings.embed_batch_size, 1)
        vectors: list[list[float]] = []

        for start in range(0, len(texts), batch_size):
            batch = texts[start:start + batch_size]
            response_vectors = await self.embedding_client.encode(batch)
            vectors.extend(response_vectors)

        return vectors

