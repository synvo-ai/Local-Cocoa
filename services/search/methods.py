"""
Two-Stage Progressive Search Methods

Stage 1: Sparse (fast) - Metadata + Fulltext (FTS5)
Stage 2: Dense (slower) - Vector + Rerank
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Callable, Any

from services.search.types import (
    Candidate,
    CandidateMeta,
    SearchMethod,
)

if TYPE_CHECKING:
    from services.search.engine import SearchEngine

logger = logging.getLogger(__name__)


# =============================================================================
# Stage 1: Sparse Search (Metadata + Fulltext)
# =============================================================================

async def method_sparse(
    engine: 'SearchEngine',
    sub_query: str,
    keywords: list[str],
    filters: dict[str, Any] | None,
    top_k: int,
) -> list[Candidate]:
    """
    Stage 1: Fast sparse search combining metadata and fulltext.
    
    - Metadata: filename, path, summary
    - Fulltext: SQLite FTS5 on extracted_text + ocr_text
    """
    started = time.perf_counter()
    candidates: list[Candidate] = []
    seen_keys: set[str] = set()
    
    def add_candidate(c: Candidate) -> None:
        key = f"{c.file_id}:{c.chunk_id or 'file'}"
        if key not in seen_keys:
            seen_keys.add(key)
            candidates.append(c)
    
    try:
        # 1. Metadata search: filename + summary
        if keywords:
            for kw in keywords[:3]:
                file_hits = engine.storage.search_files_by_filename(
                    query=kw,
                    limit=top_k // 4,
                )
                for hit in file_hits:
                    add_candidate(Candidate(
                        sub_question_id="",
                        route="metadata",
                        query_used=kw,
                        file_id=hit.file_id,
                        chunk_id=None,
                        text_preview=f"[File: {hit.name}] {hit.summary or ''}",
                        score=hit.score if hasattr(hit, 'score') else 0.5,
                        meta=CandidateMeta(
                            path=hit.path if hasattr(hit, 'path') else hit.metadata.get('path') if hasattr(hit, 'metadata') and hit.metadata else None,
                            filetype=hit.filetype if hasattr(hit, 'filetype') else None,
                            modified_time=str(hit.modified_at) if hasattr(hit, 'modified_at') else None,
                            source_fields_used=["metadata"],
                        ),
                        matched_routes=["metadata"],
                    ))
        
        # Summary search
        summary_hits = engine.storage.search_files_by_summary(
            query=sub_query,
            limit=top_k // 4,
        )
        for hit in summary_hits:
            add_candidate(Candidate(
                sub_question_id="",
                route="metadata",
                query_used=sub_query,
                file_id=hit.file_id,
                chunk_id=None,
                text_preview=f"[Summary] {hit.summary or hit.name}",
                score=hit.score if hasattr(hit, 'score') else 0.4,
                meta=CandidateMeta(
                    path=hit.path if hasattr(hit, 'path') else hit.metadata.get('path') if hasattr(hit, 'metadata') and hit.metadata else None,
                    filetype=hit.filetype if hasattr(hit, 'filetype') else None,
                    source_fields_used=["summary"],
                ),
                matched_routes=["metadata"],
            ))
        
        
        # 2. Fulltext search using FTS5 with BM25 scoring
        search_query = " ".join(keywords) if keywords else sub_query
        snippets = engine.storage.search_snippets_fts(
            query=search_query,
            limit=top_k // 2,
        )
        for hit in snippets:
            add_candidate(Candidate(
                sub_question_id="",
                route="fulltext",
                query_used=search_query,
                file_id=hit.file_id,
                chunk_id=hit.chunk_id if hasattr(hit, 'chunk_id') else None,
                text_preview=hit.snippet[:500] if hasattr(hit, 'snippet') else str(hit)[:500],
                score=hit.score if hasattr(hit, 'score') else 0.5,
                meta=CandidateMeta(
                    path=getattr(hit, 'path', None),
                    filetype=getattr(hit, 'filetype', None),
                    source_fields_used=["fulltext"],
                ),
                matched_routes=["fulltext"],
            ))
        
        logger.debug(f"[Stage 1: Sparse] found {len(candidates)} candidates in {(time.perf_counter() - started)*1000:.0f}ms")
        
    except Exception as e:
        logger.warning(f"method_sparse failed: {e}")
    
    return candidates[:top_k]


# =============================================================================
# Stage 2: Dense Search (Vector + Rerank)
# =============================================================================

async def method_dense(
    engine: 'SearchEngine',
    sub_query: str,
    keywords: list[str],
    filters: dict[str, Any] | None,
    top_k: int,
) -> list[Candidate]:
    """
    Stage 2: Dense semantic search with vector + rerank.
    
    - Vector: Embedding similarity search
    - Rerank: Cross-encoder reranking for precision
    """
    started = time.perf_counter()
    candidates: list[Candidate] = []
    
    try:
        # 1. Get query embedding
        # encode returns list[list[float]], we take the first one
        embeddings = await engine.embedding_client.encode([sub_query])
        if not embeddings:
            return []
        query_embedding = embeddings[0]
        
        # 2. Vector search
        vector_hits = engine.vector_store.search(
            query_vector=query_embedding,
            limit=top_k * 2,  # Get more for reranking
        )
        
        # Build candidates from vector hits (SearchHit objects)
        for hit in vector_hits:
            # SearchHit has: file_id, chunk_id, score, snippet, metadata
            chunk_text = hit.snippet or ""
            if not chunk_text and hit.metadata:
                chunk_text = hit.metadata.get('text', '') or hit.metadata.get('snippet', '')
            chunk_text = chunk_text[:500]
            
            file_id = hit.file_id or ""
            chunk_id = hit.chunk_id
            path = hit.metadata.get('path') if hit.metadata else None
            file_name = hit.metadata.get('name') or hit.metadata.get('file_name') if hit.metadata else None
            
            candidates.append(Candidate(
                sub_question_id="",
                route="vector",
                query_used=sub_query,
                file_id=file_id,
                chunk_id=chunk_id,
                text_preview=chunk_text,
                score=hit.score if hit.score else 0.5,
                meta=CandidateMeta(
                    path=path,
                    source_fields_used=["vector"],
                ),
                matched_routes=["vector"],
            ))
        
        # 3. Rerank if we have candidates and reranker is available
        if candidates and hasattr(engine, 'reranker_client') and engine.reranker_client:
            try:
                texts = [c.text_preview for c in candidates]
                rerank_scores = await engine.reranker_client.rerank(
                    query=sub_query,
                    documents=texts,
                )
                
                # Update scores with rerank scores
                for i, score in enumerate(rerank_scores):
                    if i < len(candidates):
                        candidates[i].score = score
                        candidates[i].matched_routes.append("rerank")
                
                # Re-sort by rerank score
                candidates.sort(key=lambda c: c.score, reverse=True)
                
            except Exception as e:
                logger.warning(f"Reranking failed: {e}")
        
        logger.debug(f"[Stage 2: Dense] found {len(candidates)} candidates in {(time.perf_counter() - started)*1000:.0f}ms")
        
    except Exception as e:
        logger.warning(f"method_dense failed: {e}")
    
    return candidates[:top_k]


# =============================================================================
# Method Registry (Two-Stage)
# =============================================================================

def build_method_list() -> list[SearchMethod]:
    """
    Build ordered list of search methods (2-stage).
    
    Stage 1: Sparse (fast) - metadata + fulltext
    Stage 2: Dense (slower) - vector + rerank
    """
    return [
        SearchMethod(
            name="sparse",
            display_name="Keyword Search",  # User-friendly: searches by keywords, file names, text
            cost_level=1,
            top_k=40,
            enabled=True,
            requires_user_opt_in=False,
        ),
        SearchMethod(
            name="dense",
            display_name="Semantic Search",  # User-friendly: AI-powered meaning-based search
            cost_level=2,
            top_k=40,
            enabled=True,
            requires_user_opt_in=False,
        ),
    ]


# Method function mapping
METHOD_FUNCTIONS: dict[str, Callable] = {
    "sparse": method_sparse,
    "dense": method_dense,
}


def get_method_fn(method_name: str) -> Callable:
    """Get the function for a method by name."""
    return METHOD_FUNCTIONS.get(method_name, method_sparse)
