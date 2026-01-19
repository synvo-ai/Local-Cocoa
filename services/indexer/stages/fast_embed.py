"""Fast Embed Processor - Round 1 Stage 2.

Takes existing text chunks and generates embeddings.
Enables vector/semantic search.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from typing import Sequence

from services.core.config import settings
from services.core.models import ChunkSnapshot, VectorDocument
from services.llm.client import EmbeddingClient
from services.storage import IndexStorage
from services.core.vector_store import VectorStore, get_vector_store
from ..state import StateManager

logger = logging.getLogger(__name__)


class FastEmbedProcessor:
    """Round 1 Stage 2: Generate embeddings for fast text chunks.
    
    Responsibilities:
    - Read existing "fast" version chunks from SQLite
    - Generate embeddings using embedding model
    - Store vectors in Qdrant
    - Update fast_stage from 1 -> 2
    
    Optimized for batch processing to improve throughput.
    """

    def __init__(
        self,
        storage: IndexStorage,
        state_manager: StateManager,
        *,
        embedding_client: EmbeddingClient,
        vectors: Optional[VectorStore] = None,
    ) -> None:
        self.storage = storage
        self.state_manager = state_manager
        self.embedding_client = embedding_client
        self.vector_store = vectors or get_vector_store()

    async def process(self, file_id: str) -> bool:
        """Generate embeddings for a single file's chunks.
        
        Args:
            file_id: The file ID to process
            
        Returns:
            True if successful, False otherwise
        """
        file_record = self.storage.get_file(file_id)
        if not file_record:
            logger.warning("File not found: %s", file_id)
            return False

        # Must have completed fast_text first
        if file_record.fast_stage < 1:
            logger.warning("File %s hasn't completed fast_text yet", file_id)
            return False

        if file_record.fast_stage >= 2:
            logger.debug("File %s already has fast_stage >= 2, skipping", file_id)
            return True

        try:
            # Set active file for progress display
            self.state_manager.set_active_file(
                folder_id=file_record.folder_id,
                folder_path=str(file_record.path.parent) if file_record.path else None,
                file_path=file_record.path,
                file_name=file_record.name,
                kind=file_record.kind,
            )

            # Get chunks for this file
            chunks = self.storage.chunks_for_file(file_id)
            fast_chunks = [c for c in chunks if c.version == "fast"]

            if not fast_chunks:
                logger.warning("No fast chunks found for file %s", file_id)
                # Mark as done anyway
                now = dt.datetime.now(dt.timezone.utc)
                self.storage.update_file_stage(
                    file_id,
                    fast_stage=2,
                    fast_embed_at=now
                )
                file_record.fast_stage = 2
                file_record.fast_embed_at = now
                file_record.index_status = "indexed"
                self.storage.upsert_file(file_record)
                return True

            # Update state for UI
            self.state_manager.set_active_stage(
                stage="fast_embed",
                detail=f"Embedding {len(fast_chunks)} chunks",
                progress=0.0,
                event=f"Embedding {file_record.name}"
            )

            # Generate embeddings
            vectors = await self._embed_chunks(fast_chunks)

            if len(vectors) != len(fast_chunks):
                logger.warning(
                    "Embedding count mismatch for %s: got %d, expected %d",
                    file_id, len(vectors), len(fast_chunks)
                )

            # Build vector documents
            documents: list[VectorDocument] = []
            for chunk, vector in zip(fast_chunks, vectors):
                doc_metadata = {
                    "chunk_id": chunk.chunk_id,
                    "file_id": file_record.id,
                    "file_name": file_record.name,
                    "name": file_record.name,
                    "path": str(file_record.path),
                    "full_path": str(file_record.path),
                    "folder_id": file_record.folder_id,
                    "extension": file_record.extension,
                    "size": file_record.size,
                    "modified_at": file_record.modified_at.isoformat() if file_record.modified_at else None,
                    "created_at": file_record.created_at.isoformat() if file_record.created_at else None,
                    "summary": file_record.summary,
                    "snippet": chunk.snippet,
                    "kind": file_record.kind,
                    "section_path": chunk.section_path,
                    "token_count": chunk.token_count,
                    "char_count": chunk.char_count,
                    "version": "fast",
                }
                # Add page info if available
                if chunk.metadata:
                    for key in ["page_number", "page_numbers", "page_start", "page_end"]:
                        if key in chunk.metadata:
                            doc_metadata[key] = chunk.metadata[key]
                    if "page_number" in chunk.metadata:
                        doc_metadata["page"] = chunk.metadata["page_number"]

                documents.append(VectorDocument(
                    doc_id=chunk.chunk_id,
                    vector=vector,
                    metadata=doc_metadata,
                ))

            # Store in vector database
            if documents:
                try:
                    self.vector_store.upsert(documents)
                    self.vector_store.flush()
                except Exception as exc:
                    logger.warning("Vector store upsert failed for %s: %s", file_id, exc)
                    # Continue anyway, chunks are still searchable via FTS

            # Update file record
            now = dt.datetime.now(dt.timezone.utc)
            file_record.metadata = file_record.metadata or {}
            file_record.metadata["vector_chunks"] = [doc.doc_id for doc in documents]
            
            if vectors:
                file_record.embedding_vector = vectors[0]
                file_record.embedding_determined_at = now

            file_record.fast_stage = 2
            file_record.fast_embed_at = now
            file_record.index_status = "indexed"  # Now fully searchable
            file_record.error_reason = None
            file_record.error_at = None

            self.storage.upsert_file(file_record)

            logger.info(
                "Fast embed completed for %s: %d vectors stored",
                file_record.name, len(documents)
            )
            return True

        except Exception as exc:
            logger.warning("Fast embed failed for %s: %s", file_id, exc)
            # Don't set fast_stage to -1, allow retry
            return False

        finally:
            self.state_manager.reset_active_state()

    async def process_batch(self, file_ids: list[str]) -> int:
        """Process multiple files' embeddings in batch for efficiency.
        
        Args:
            file_ids: List of file IDs to process
            
        Returns:
            Number of successfully processed files
        """
        if not file_ids:
            return 0

        success_count = 0
        
        # Collect all chunks from all files
        all_chunks: list[tuple[str, ChunkSnapshot]] = []  # (file_id, chunk)
        file_records: dict[str, any] = {}

        files_without_chunks: list[str] = []  # Track files that have no chunks
        
        for file_id in file_ids:
            file_record = self.storage.get_file(file_id)
            if not file_record:
                continue
            if file_record.fast_stage < 1:
                continue
            if file_record.fast_stage >= 2:
                success_count += 1
                continue

            file_records[file_id] = file_record
            chunks = self.storage.chunks_for_file(file_id)
            fast_chunks = [c for c in chunks if c.version == "fast"]
            
            if not fast_chunks:
                # File has no fast chunks - mark as done anyway
                files_without_chunks.append(file_id)
            else:
                for chunk in fast_chunks:
                    all_chunks.append((file_id, chunk))

        # Update files that have no chunks (mark them as complete)
        now = dt.datetime.now(dt.timezone.utc)
        for file_id in files_without_chunks:
            file_record = file_records.get(file_id)
            if file_record:
                file_record.fast_stage = 2
                file_record.fast_embed_at = now
                file_record.index_status = "indexed"
                self.storage.upsert_file(file_record)
                success_count += 1
                logger.info("File %s has no fast chunks, marked as complete", file_id)

        if not all_chunks:
            return success_count

        # Get first file for progress display
        first_file_id = next((fid for fid, _ in all_chunks), None)
        if first_file_id and first_file_id in file_records:
            first_file = file_records[first_file_id]
            self.state_manager.set_active_file(
                folder_id=first_file.folder_id,
                folder_path=str(first_file.path.parent) if first_file.path else None,
                file_path=first_file.path,
                file_name=first_file.name,
                kind=first_file.kind,
            )

        # Batch embed all chunks at once
        self.state_manager.set_active_stage(
            stage="fast_embed",
            detail=f"Embedding {len(all_chunks)} chunks from {len(file_records)} files",
            progress=0.0,
            step_current=0,
            step_total=len(file_records),
            event=f"Starting embedding for {len(file_records)} files",
        )

        try:
            texts = [chunk.text.strip()[:settings.embed_max_chars] for _, chunk in all_chunks]
            vectors = await self._embed_texts_batch(texts)

            # Group results by file
            file_vectors: dict[str, list[tuple[ChunkSnapshot, list[float]]]] = {}
            for (file_id, chunk), vector in zip(all_chunks, vectors):
                if file_id not in file_vectors:
                    file_vectors[file_id] = []
                file_vectors[file_id].append((chunk, vector))

            # Store vectors and update files
            now = dt.datetime.now(dt.timezone.utc)
            total_files = len(file_vectors)
            for file_idx, (file_id, chunk_vectors) in enumerate(file_vectors.items(), start=1):
                file_record = file_records.get(file_id)
                if not file_record:
                    continue

                # Update progress for this file
                self.state_manager.set_active_file(
                    folder_id=file_record.folder_id,
                    folder_path=str(file_record.path.parent) if file_record.path else None,
                    file_path=file_record.path,
                    file_name=file_record.name,
                    kind=file_record.kind,
                )
                self.state_manager.set_active_stage(
                    stage="fast_embed",
                    detail=f"Storing vectors for {file_record.name}",
                    step_current=file_idx,
                    step_total=total_files,
                    progress=(file_idx / total_files) * 100,
                    event=f"Stored {len(chunk_vectors)} vectors for {file_record.name}",
                )

                documents: list[VectorDocument] = []
                for chunk, vector in chunk_vectors:
                    doc_metadata = {
                        "chunk_id": chunk.chunk_id,
                        "file_id": file_record.id,
                        "file_name": file_record.name,
                        "path": str(file_record.path),
                        "folder_id": file_record.folder_id,
                        "extension": file_record.extension,
                        "kind": file_record.kind,
                        "snippet": chunk.snippet,
                        "version": "fast",
                        # Privacy level for filtering - external requests cannot see private files
                        "privacy_level": file_record.privacy_level,
                    }
                    documents.append(VectorDocument(
                        doc_id=chunk.chunk_id,
                        vector=vector,
                        metadata=doc_metadata,
                    ))

                if documents:
                    try:
                        self.vector_store.upsert(documents)
                    except Exception as exc:
                        logger.warning("Vector upsert failed for %s: %s", file_id, exc)
                        # Continue to update file status anyway - FTS still works

                # Update file (always, even if vector upsert failed)
                file_record.metadata = file_record.metadata or {}
                file_record.metadata["vector_chunks"] = [d.doc_id for d in documents]
                if chunk_vectors:
                    file_record.embedding_vector = chunk_vectors[0][1]
                    file_record.embedding_determined_at = now
                file_record.fast_stage = 2
                file_record.fast_embed_at = now
                file_record.index_status = "indexed"
                self.storage.upsert_file(file_record)
                success_count += 1

            # Flush vector store once at the end
            self.vector_store.flush()

        except Exception as exc:
            logger.warning("Batch embedding failed: %s", exc)

        finally:
            self.state_manager.reset_active_state()

        return success_count

    async def _embed_chunks(self, chunks: Sequence[ChunkSnapshot]) -> list[list[float]]:
        """Generate embeddings for chunks."""
        texts = [c.text.strip()[:settings.embed_max_chars] for c in chunks if c.text.strip()]
        if not texts:
            return []
        return await self._embed_texts_batch(texts)

    async def _embed_texts_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed texts in batches with parallel requests for better GPU utilization."""
        if not texts:
            return []

        # Batch size per request - smaller batches allow parallel processing across slots
        batch_size = max(settings.embed_batch_size, 16)
        # Number of concurrent requests to send (matches llama-server parallel slots)
        num_parallel = 4  # Send 4 requests in parallel to utilize multiple GPU slots
        
        delay_seconds = settings.embed_batch_delay_ms / 1000 if settings.embed_batch_delay_ms else 0.0

        # Split texts into batches
        batches: list[list[str]] = []
        for start in range(0, len(texts), batch_size):
            batches.append(texts[start:start + batch_size])
        
        total_batches = len(batches)
        vectors: list[list[float]] = []
        
        # Process batches in parallel groups
        for group_start in range(0, total_batches, num_parallel):
            group_end = min(group_start + num_parallel, total_batches)
            group_batches = batches[group_start:group_end]
            
            current_batch = group_start + len(group_batches)
            self.state_manager.set_active_stage(
                stage="fast_embed",
                detail=f"Embedding batch {current_batch}/{total_batches} ({num_parallel}x parallel)",
                step_current=current_batch,
                step_total=total_batches,
                progress=(group_start / max(total_batches, 1)) * 100,
                event=f"Processing batch {current_batch}/{total_batches}",
            )
            
            # Send multiple requests in parallel using asyncio.gather
            tasks = [self.embedding_client.encode(batch) for batch in group_batches]
            results = await asyncio.gather(*tasks)
            
            # Flatten results in order
            for result in results:
                vectors.extend(result)

            if delay_seconds > 0 and group_end < total_batches:
                await asyncio.sleep(delay_seconds)

        return vectors

