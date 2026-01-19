from __future__ import annotations

import logging
import uuid
from typing import Iterable, Optional, Sequence

from qdrant_client import QdrantClient, models

from .config import settings
from .models import SearchHit, VectorDocument
from .request_context import RequestContext, get_request_context


logger = logging.getLogger(__name__)


class VectorStore:
    def __init__(self) -> None:
        # Ensure the path exists or Qdrant might complain if it's a file path vs dir
        # QdrantClient(path=...) treats it as a directory for local persistence.
        self.client = QdrantClient(path=settings.qdrant.path)
        self.collection = settings.qdrant.collection_name
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        try:
            if not self.client.collection_exists(self.collection):
                metric = models.Distance.COSINE
                if settings.qdrant.metric_type == "EUCLID":
                    metric = models.Distance.EUCLID
                elif settings.qdrant.metric_type == "DOT":
                    metric = models.Distance.DOT

                self.client.create_collection(
                    collection_name=self.collection,
                    vectors_config=models.VectorParams(
                        size=settings.qdrant.embedding_dim,
                        distance=metric
                    )
                )
        except Exception as exc:
            logger.warning("Qdrant collection setup failed: %s", exc)

    def upsert(self, documents: Sequence[VectorDocument]) -> None:
        if not documents:
            return

        points = []
        for doc in documents:
            # Generate a deterministic UUID from the doc_id
            point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, doc.doc_id))
            # Ensure doc_id is in metadata if not already
            payload = doc.metadata.copy()
            payload["_id"] = doc.doc_id  # Store original ID just in case

            points.append(models.PointStruct(
                id=point_id,
                vector=doc.vector,
                payload=payload
            ))

        try:
            self.client.upsert(collection_name=self.collection, points=points)
        except Exception as exc:
            logger.warning("Qdrant upsert failed: %s", exc)
            # Handle dimension mismatch if possible
            if "Wrong input vector dimension" in str(exc):
                logger.warning(
                    "Detected dimension mismatch for collection '%s'. Recreating with dim=%s.",
                    self.collection,
                    settings.qdrant.embedding_dim,
                )
                self._recreate_collection()
                self.client.upsert(collection_name=self.collection, points=points)
            else:
                raise

    def delete(self, doc_ids: Iterable[str]) -> None:
        ids = [str(uuid.uuid5(uuid.NAMESPACE_DNS, doc_id)) for doc_id in doc_ids]
        if not ids:
            return
        try:
            self.client.delete(
                collection_name=self.collection,
                points_selector=models.PointIdsList(points=ids)
            )
        except Exception as exc:
            logger.warning("Qdrant delete failed: %s", exc)

    def delete_by_filter(self, folder_id: str | None = None, file_id: str | None = None) -> None:
        if not folder_id and not file_id:
            return

        must_conditions = []
        if folder_id:
            must_conditions.append(
                models.FieldCondition(
                    key="folder_id",
                    match=models.MatchValue(value=folder_id)
                )
            )
        if file_id:
            must_conditions.append(
                models.FieldCondition(
                    key="file_id",
                    match=models.MatchValue(value=file_id)
                )
            )

        try:
            self.client.delete(
                collection_name=self.collection,
                points_selector=models.FilterSelector(
                    filter=models.Filter(must=must_conditions)
                )
            )
        except Exception as exc:
            logger.warning("Qdrant delete by filter failed: %s", exc)

    def search(
        self, 
        query_vector: Sequence[float], 
        limit: int = 5, 
        file_ids: list[str] | None = None,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        Search for similar vectors with privacy filtering.
        
        Args:
            query_vector: The query embedding vector
            limit: Maximum number of results
            file_ids: Optional list of file IDs to restrict search to
            ctx: Optional RequestContext for privacy filtering (uses current context if None)
            
        Returns:
            List of SearchHit results, filtered by privacy level
        """
        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()
        
        # Build filter conditions
        must_conditions: list[models.FieldCondition] = []
        
        # File ID filter
        if file_ids:
            must_conditions.append(
                models.FieldCondition(
                    key="file_id",
                    match=models.MatchAny(any=file_ids)
                )
            )
        
        # Privacy filter - CRITICAL: Filter at earliest stage
        # External requests (API, MCP, plugins) can only see normal files
        if not ctx.can_access_private:
            must_conditions.append(
                models.FieldCondition(
                    key="privacy_level",
                    match=models.MatchValue(value="normal")
                )
            )
        
        query_filter = models.Filter(must=must_conditions) if must_conditions else None

        try:
            response = self.client.query_points(
                collection_name=self.collection,
                query=query_vector,
                limit=limit,
                with_payload=True,
                query_filter=query_filter,
            )
        except Exception as exc:
            logger.warning("Qdrant search failed: %s", exc)
            return []

        hits: list[SearchHit] = []

        for result in response.points:
            metadata = result.payload or {}

            original_id = metadata.get("_id") or str(result.id)

            file_id = metadata.get("file_id") or original_id
            chunk_id = metadata.get("chunk_id") or original_id
            metadata.setdefault("chunk_id", chunk_id)

            hits.append(
                SearchHit(
                    file_id=file_id,
                    score=result.score,
                    summary=metadata.get("summary"),
                    snippet=metadata.get("snippet"),
                    metadata=metadata,
                    chunk_id=chunk_id,
                )
            )

        return hits
    
    def update_privacy_level(self, file_id: str, privacy_level: str) -> None:
        """
        Update the privacy level of all vectors belonging to a file.
        
        Args:
            file_id: The file ID whose vectors should be updated
            privacy_level: The new privacy level ("normal" or "private")
        """
        try:
            self.client.set_payload(
                collection_name=self.collection,
                payload={"privacy_level": privacy_level},
                points=models.FilterSelector(
                    filter=models.Filter(
                        must=[
                            models.FieldCondition(
                                key="file_id",
                                match=models.MatchValue(value=file_id)
                            )
                        ]
                    )
                )
            )
            logger.info(f"Updated privacy_level to '{privacy_level}' for file {file_id}")
        except Exception as exc:
            logger.warning(f"Failed to update privacy level for file {file_id}: {exc}")

    def flush(self) -> None:
        # Qdrant local persists automatically, but we can try to ensure it.
        pass

    def _recreate_collection(self) -> None:
        self.drop_collection()
        self._ensure_collection()

    def drop_collection(self) -> None:
        try:
            self.client.delete_collection(self.collection)
        except Exception as exc:
            logger.warning("Qdrant drop collection failed for '%s': %s", self.collection, exc)
        self._ensure_collection()


_vector_store: Optional[VectorStore] = None


def get_vector_store() -> VectorStore:
    global _vector_store
    if _vector_store is None:
        _vector_store = VectorStore()
    return _vector_store


# Use get_vector_store() to access the vector store instance.
# Avoid top-level initialization to prevent issues during static analysis or shutdown.
