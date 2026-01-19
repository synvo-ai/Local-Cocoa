"""
Multi-route retrieval engine for FileMenuSystem Search.

Implements:
- Route 1: Vector DB recall (Embedding)
- Route 2: Fulltext/keyword search (BM25/FTS)
- Route 3: Metadata field search (path, filename, filetype, time)
- Route 4: Hybrid fusion (RRF)
"""

from __future__ import annotations

import asyncio
import logging
import time
import re
from typing import Any, TYPE_CHECKING

from services.core.config import settings
from services.core.models import SearchHit
from .types import (
    SubQuestion,
    RetrievalQuery,
    Candidate,
    CandidateMeta,
    VerifyResult,
    VerifiedCandidate,
    DebugStep,
    RetrievalLimits,
)

if TYPE_CHECKING:
    from .engine import SearchEngine

logger = logging.getLogger(__name__)


class MultiRouteRetriever:
    """
    Multi-route retrieval engine with cascade ordering (fast to slow).
    
    Route Order (fastest first):
    1. Metadata (filename/path matching) - ~1ms, no AI
    2. Fulltext (BM25/keyword search) - ~10ms, no AI
    3. Vector (embedding similarity) - ~100ms, needs embedding
    4. Hybrid (RRF fusion) - only if previous routes insufficient
    
    Each stage can exit early if enough high-confidence results are found.
    """

    def __init__(self, engine: 'SearchEngine'):
        self.engine = engine
        self.storage = engine.storage
        self.embedding_client = engine.embedding_client
        self.vector_store = engine.vector_store

    async def retrieve_for_sub_question(
        self,
        sub_question: SubQuestion,
        retrieval_query: RetrievalQuery,
        limits: RetrievalLimits | None = None,
        verify_callback: callable | None = None,
    ) -> tuple[list[Candidate], list[DebugStep], bool]:
        """
        Execute cascade retrieval for a single sub-question.
        
        Order: Metadata (fastest) → Fulltext → Vector → Hybrid (slowest)
        
        Args:
            sub_question: The sub-question to search for
            retrieval_query: Dense/sparse queries for retrieval
            limits: Budget limits for retrieval
            verify_callback: Optional async callback(candidates) -> (verified, found_answer)
                             Used for early exit verification
        
        Returns:
            tuple of (candidates, debug_steps, early_exit_available)
            - early_exit_available: True if more routes could be searched
        """
        if limits is None:
            limits = RetrievalLimits()

        debug_steps: list[DebugStep] = []
        all_candidates: list[Candidate] = []
        early_exit_available = False
        
        # Route order: fastest to slowest
        route_order = [
            ("metadata", self._route_metadata, retrieval_query),
            ("fulltext", self._route_fulltext, retrieval_query.sparse_query),
            ("vector", self._route_vector, retrieval_query.dense_query),
        ]
        
        for route_name, route_fn, query_arg in route_order:
            started = time.perf_counter()
            
            # Execute route
            try:
                if route_name == "metadata":
                    candidates = await route_fn(sub_question.id, query_arg, limits.per_route_top_k)
                else:
                    candidates = await route_fn(sub_question.id, query_arg, limits.per_route_top_k)
            except Exception as e:
                logger.warning(f"Route '{route_name}' failed: {e}")
                candidates = []
            
            duration_ms = int((time.perf_counter() - started) * 1000)
            
            # Add debug step
            query_used = (
                retrieval_query.sparse_query if route_name in ("metadata", "fulltext")
                else retrieval_query.dense_query
            )
            debug_steps.append(DebugStep(
                step_type="retrieval",
                sub_question_id=sub_question.id,
                route=route_name,  # type: ignore
                query_used=query_used,
                candidates=candidates[:5],  # Top 5 for display
                metadata={
                    "total_candidates": len(candidates),
                    "route_order": route_order.index((route_name, route_fn, query_arg)) + 1,
                },
                duration_ms=duration_ms,
            ))
            
            # Accumulate candidates
            all_candidates.extend(candidates)
            
            # Early verification check (if callback provided)
            if verify_callback and candidates:
                verified, found_answer = await verify_callback(candidates)
                if found_answer:
                    logger.info(f"Early exit at route '{route_name}': found answer")
                    # Mark remaining routes as available
                    remaining_routes = [r[0] for r in route_order if route_order.index((route_name, route_fn, query_arg)) < route_order.index(r)]
                    early_exit_available = len(remaining_routes) > 0
                    
                    # Return early with merged results
                    merged = self._merge_rrf({"current": all_candidates}, limits.merge_top_n)
                    debug_steps.append(DebugStep(
                        step_type="merge",
                        sub_question_id=sub_question.id,
                        candidates=merged[:5],
                        metadata={
                            "early_exit": True,
                            "stopped_at_route": route_name,
                            "remaining_routes": remaining_routes,
                            "total_candidates": len(all_candidates),
                        },
                        duration_ms=0,
                    ))
                    return merged, debug_steps, early_exit_available
        
        # All routes completed - merge with RRF
        merge_start = time.perf_counter()
        
        # Group candidates by their original route for proper RRF scoring
        candidates_by_route: dict[str, list[Candidate]] = {}
        for c in all_candidates:
            route = c.route
            if route not in candidates_by_route:
                candidates_by_route[route] = []
            candidates_by_route[route].append(c)
        
        merged = self._merge_rrf(candidates_by_route, limits.merge_top_n)
        
        debug_steps.append(DebugStep(
            step_type="merge",
            sub_question_id=sub_question.id,
            candidates=merged[:5],
            metadata={
                "total_before_merge": len(all_candidates),
                "total_after_merge": len(merged),
                "fusion_method": "RRF",
                "routes_used": list(candidates_by_route.keys()),
            },
            duration_ms=int((time.perf_counter() - merge_start) * 1000),
        ))

        return merged, debug_steps, False  # No early exit, all routes used

    async def _route_vector(
        self,
        sub_question_id: str,
        query: str,
        limit: int,
    ) -> list[Candidate]:
        """Route 1: Vector DB recall (Embedding)."""
        try:
            # Get embedding for the query
            embeddings = await self.embedding_client.encode([query])
            if not embeddings:
                return []
            
            # Search vector store
            hits = self.vector_store.search(embeddings[0], limit=limit)
            
            # Convert to Candidates
            candidates = []
            for hit in hits:
                chunk_text = self._get_chunk_text(hit)
                candidates.append(Candidate(
                    sub_question_id=sub_question_id,
                    route="vector",
                    query_used=query,
                    file_id=hit.file_id,
                    chunk_id=hit.chunk_id,
                    text_preview=chunk_text[:200] if chunk_text else "",
                    score=hit.score,
                    meta=self._build_meta(hit),
                    matched_routes=["vector"],
                ))
            
            logger.debug(f"Vector route found {len(candidates)} candidates for query: {query[:50]}...")
            return candidates
            
        except Exception as e:
            logger.error(f"Vector route error: {e}")
            return []

    async def _route_fulltext(
        self,
        sub_question_id: str,
        query: str,
        limit: int,
    ) -> list[Candidate]:
        """Route 2: Fulltext/keyword search (BM25/FTS on extracted_text/ocr_text)."""
        try:
            # Use existing lexical search
            hits = self.storage.search_snippets(query, limit=limit)
            
            candidates = []
            for hit in hits:
                chunk_text = self._get_chunk_text(hit)
                candidates.append(Candidate(
                    sub_question_id=sub_question_id,
                    route="fulltext",
                    query_used=query,
                    file_id=hit.file_id,
                    chunk_id=hit.chunk_id,
                    text_preview=chunk_text[:200] if chunk_text else "",
                    score=hit.score,
                    meta=self._build_meta(hit, source_field="extracted_text"),
                    matched_routes=["fulltext"],
                ))
            
            logger.debug(f"Fulltext route found {len(candidates)} candidates for query: {query[:50]}...")
            return candidates
            
        except Exception as e:
            logger.error(f"Fulltext route error: {e}")
            return []

    async def _route_metadata(
        self,
        sub_question_id: str,
        retrieval_query: RetrievalQuery,
        limit: int,
    ) -> list[Candidate]:
        """Route 3: Metadata field search (path, filename, filetype, time)."""
        try:
            candidates = []
            
            # Extract keywords from sparse query for filename/path matching
            keywords = [k.strip() for k in retrieval_query.sparse_query.split() if len(k.strip()) >= 2]
            
            # Search by filename
            for keyword in keywords[:3]:  # Limit to first 3 keywords
                files = self.storage.find_files_by_name(keyword)
                for file_record in files[:limit // 3]:  # Distribute limit across keywords
                    candidates.append(Candidate(
                        sub_question_id=sub_question_id,
                        route="metadata",
                        query_used=f"filename:{keyword}",
                        file_id=file_record.id,
                        chunk_id=None,
                        text_preview=f"File: {file_record.name}",
                        score=0.8,  # Fixed score for metadata matches
                        meta=CandidateMeta(
                            path=str(file_record.path),
                            filetype=file_record.extension,
                            modified_time=file_record.modified_at.isoformat() if file_record.modified_at else None,
                            source_fields_used=["filename"],
                        ),
                        matched_routes=["metadata"],
                    ))
            
            # Apply metadata filters if present
            if retrieval_query.metadata_filters:
                filters = retrieval_query.metadata_filters
                
                # Search by summary if available
                if keywords:
                    summary_hits = self.storage.search_files_by_summary(" ".join(keywords), limit=limit)
                    for hit in summary_hits:
                        candidates.append(Candidate(
                            sub_question_id=sub_question_id,
                            route="metadata",
                            query_used=f"summary:{' '.join(keywords)}",
                            file_id=hit.file_id,
                            chunk_id=None,
                            text_preview=hit.summary or hit.snippet or "",
                            score=hit.score,
                            meta=self._build_meta(hit, source_field="summary"),
                            matched_routes=["metadata"],
                        ))
            
            # Deduplicate by file_id
            seen_files: set[str] = set()
            unique_candidates = []
            for c in candidates:
                if c.file_id not in seen_files:
                    seen_files.add(c.file_id)
                    unique_candidates.append(c)
            
            logger.debug(f"Metadata route found {len(unique_candidates)} candidates")
            return unique_candidates[:limit]
            
        except Exception as e:
            logger.error(f"Metadata route error: {e}")
            return []

    def _merge_rrf(
        self,
        candidates_by_route: dict[str, list[Candidate]],
        limit: int,
    ) -> list[Candidate]:
        """
        Merge candidates from multiple routes using Reciprocal Rank Fusion (RRF).
        
        RRF Score = Σ 1/(k + rank_i) for each route where the candidate appears
        """
        k = 60  # RRF constant

        # Track scores and best candidate per (file_id, chunk_id)
        combined_scores: dict[str, float] = {}
        candidate_map: dict[str, Candidate] = {}
        matched_routes_map: dict[str, list[str]] = {}

        for route, candidates in candidates_by_route.items():
            for rank, candidate in enumerate(candidates, start=1):
                # Create unique key
                key = f"{candidate.file_id}:{candidate.chunk_id or 'file'}"
                
                rrf_score = 1.0 / (k + rank)
                combined_scores[key] = combined_scores.get(key, 0.0) + rrf_score
                
                # Track matched routes
                if key not in matched_routes_map:
                    matched_routes_map[key] = []
                if route not in matched_routes_map[key]:
                    matched_routes_map[key].append(route)
                
                # Keep first seen candidate (or update if higher score in this route)
                if key not in candidate_map:
                    candidate_map[key] = candidate

        # Sort by combined RRF score
        sorted_keys = sorted(combined_scores.keys(), key=lambda k: combined_scores[k], reverse=True)

        # Build merged list
        merged: list[Candidate] = []
        for key in sorted_keys[:limit]:
            candidate = candidate_map[key]
            # Update candidate with merged info
            merged_candidate = Candidate(
                sub_question_id=candidate.sub_question_id,
                route="hybrid",
                query_used=candidate.query_used,
                file_id=candidate.file_id,
                chunk_id=candidate.chunk_id,
                text_preview=candidate.text_preview,
                score=combined_scores[key],
                meta=candidate.meta,
                matched_routes=matched_routes_map[key],
            )
            merged.append(merged_candidate)

        logger.debug(f"RRF merged {sum(len(c) for c in candidates_by_route.values())} candidates into {len(merged)}")
        return merged

    def _get_chunk_text(self, hit: SearchHit) -> str:
        """Get the text content for a search hit."""
        # Try snippet first
        if hit.snippet:
            return hit.snippet
        
        # Try to get from chunk
        if hit.chunk_id:
            chunk = self.storage.get_chunk(hit.chunk_id)
            if chunk:
                return chunk.text
        
        # Fallback to summary
        return hit.summary or ""

    def _build_meta(
        self,
        hit: SearchHit,
        source_field: str | None = None,
    ) -> CandidateMeta:
        """Build CandidateMeta from a SearchHit."""
        meta = hit.metadata or {}
        return CandidateMeta(
            path=meta.get("path"),
            filetype=meta.get("extension") or meta.get("kind"),
            modified_time=meta.get("modified_at"),
            author=meta.get("author"),
            source_fields_used=[source_field] if source_field else ["embedding"],
        )


async def extract_keywords(sub_question: SubQuestion, llm_client: Any = None) -> RetrievalQuery:
    """
    Extract keywords and build retrieval queries from a sub-question.
    
    If llm_client is provided, use LLM for intelligent keyword extraction.
    Otherwise, use simple rule-based extraction.
    """
    question = sub_question.question
    
    # Simple extraction (rule-based)
    # Remove common words
    stop_words = {
        "what", "when", "where", "who", "which", "how", "why",
        "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did",
        "the", "a", "an", "and", "or", "but", "in", "on", "at",
        "to", "for", "of", "with", "by", "from", "as", "into",
        "about", "any", "all", "some", "can", "could", "would",
        "should", "will", "shall", "may", "might", "must",
        "this", "that", "these", "those", "my", "your", "our",
        "their", "its", "i", "you", "we", "they", "he", "she", "it",
    }
    
    # Extract words
    words = re.findall(r'\b\w+\b', question.lower())
    keywords = [w for w in words if w not in stop_words and len(w) >= 2]
    
    # Extract metadata filters from constraints
    metadata_filters = None
    if sub_question.constraints:
        metadata_filters = {}
        if "time_range" in sub_question.constraints:
            metadata_filters["time_range"] = sub_question.constraints["time_range"]
        if "file_types" in sub_question.constraints:
            metadata_filters["file_types"] = sub_question.constraints["file_types"]
        if "path_scope" in sub_question.constraints:
            metadata_filters["path_scope"] = sub_question.constraints["path_scope"]
    
    return RetrievalQuery(
        dense_query=question,  # Use full question for embedding
        sparse_query=" ".join(keywords),  # Keywords for BM25
        metadata_filters=metadata_filters,
    )
