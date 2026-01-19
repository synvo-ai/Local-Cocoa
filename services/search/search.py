from __future__ import annotations
import logging
import json
import time
import asyncio
import uuid
from typing import Any, Iterable, List, AsyncIterable, TYPE_CHECKING, Callable, Awaitable
import re
import os


from services.llm.client import EmbeddingClient, RerankClient
from services.core.config import settings
from services.core.models import (
    SearchHit,
    SearchResponse,
    AgentStepFile, # Added back as it's used in _step_files
)
from services.storage import IndexStorage
from services.core.vector_store import VectorStore
from .types import (
    AuthenticationError,
    EmbeddingUnavailableError,
    StepRecorder,
    QueryRewriteResult,
    SubQuestion,
    RetrievalQuery,
    DebugStep,
)
from services.core.models import SubQueryResult
from .progressive import search_pipeline

if TYPE_CHECKING:
    from .engine import SearchEngine

logger = logging.getLogger(__name__)


class SearchMixin:
    """
    Mixin containing search logic for SearchEngine.
    """

    def _hit_label(self: 'SearchEngine', hit: SearchHit) -> str:
        metadata = hit.metadata or {}
        label = (
            metadata.get("path")
            or metadata.get("file_path")
            or metadata.get("full_path")
            or metadata.get("file_name")
            or metadata.get("name")
            or metadata.get("title")
        )
        return str(label or hit.file_id)

    def _step_files(self: 'SearchEngine', hits: list[SearchHit], limit: int = 3) -> list[AgentStepFile]:
        files: list[AgentStepFile] = []
        for hit in hits[:limit]:
            files.append(AgentStepFile(file_id=hit.file_id, label=self._hit_label(hit), score=hit.score))
        return files

    def _chunk_text(self: 'SearchEngine', hit: SearchHit) -> str | None:
        metadata = hit.metadata or {}
        chunk_id = metadata.get("chunk_id") or hit.chunk_id
        if not chunk_id:
            return None
        chunk = self.storage.get_chunk(chunk_id)
        if chunk and chunk.text:
            return chunk.text.strip()
        return None

    def _collect_multi_vector_hits(
        self: 'SearchEngine',
        queries: list[str],
        embeddings: list[list[float]],
        limit: int,
        file_ids: list[str] | None = None,
    ) -> tuple[list[SearchHit], list[tuple[str, list[SearchHit]]]]:
        # Collect chunks from all queries (track by chunk_id to avoid exact duplicates)
        seen_chunks: dict[str, SearchHit] = {}
        per_query: list[tuple[str, list[SearchHit]]] = []

        for query, vector in zip(queries, embeddings):
            hits = self._vector_hits(query, vector, limit, file_ids=file_ids)
            per_query.append((query, hits))
            for hit in hits:
                # Use chunk_id as key to avoid duplicate chunks, keep highest score
                chunk_key = hit.chunk_id or hit.file_id
                existing = seen_chunks.get(chunk_key)
                if existing is None or hit.score > existing.score:
                    seen_chunks[chunk_key] = hit

        ordered_hits = sorted(seen_chunks.values(), key=lambda item: item.score, reverse=True)
        return ordered_hits, per_query

    def _vector_hits(self: 'SearchEngine', query: str, query_vector: list[float], limit: int, file_ids: list[str] | None = None) -> list[SearchHit]:
        from .utils import _cosine_similarity
        if self.vector_store:
            # Fetch more chunks than needed to ensure we get enough after enrichment
            raw_hits = self.vector_store.search(query_vector, limit=limit * 3, file_ids=file_ids)
            enriched_hits: list[SearchHit] = []

            for raw in raw_hits:
                file_id = raw.metadata.get("file_id") or raw.file_id
                record = self.storage.get_file(file_id)

                # Backward compatibility: if file not found by file_id, try chunk_id
                if not record and raw.chunk_id:
                    record = self.storage.get_file_by_chunk_id(raw.chunk_id)

                summary = record.summary if record else raw.summary
                snippet = raw.snippet or (summary[:480] if summary else None)

                # Enrich metadata with file information from database
                enriched_metadata = dict(raw.metadata) if raw.metadata else {}
                
                # Extract and merge chunk_metadata (contains page numbers, etc.)
                chunk_metadata = enriched_metadata.get("chunk_metadata")
                if chunk_metadata and isinstance(chunk_metadata, dict):
                    # Merge chunk_metadata into top-level metadata for easier access
                    for key, value in chunk_metadata.items():
                        if key not in enriched_metadata or enriched_metadata.get(key) is None:
                            enriched_metadata[key] = value
                
                if record:
                    enriched_metadata.update({
                        "file_id": record.id,
                        "file_name": record.name,
                        "name": record.name,
                        "path": str(record.path),
                        "full_path": str(record.path),
                        "file_path": str(record.path),
                        "extension": record.extension,
                        "size": record.size,
                        "kind": record.kind,
                        "folder_id": record.folder_id,
                    })

                enriched = raw.copy(
                    update={
                        "file_id": record.id if record else file_id,
                        "summary": summary,
                        "snippet": snippet,
                        "chunk_id": raw.chunk_id,
                        "metadata": enriched_metadata,
                    }
                )
                enriched_hits.append(enriched)

            # Return all chunks sorted by score (no aggregation by file_id)
            hits = sorted(enriched_hits, key=lambda item: item.score, reverse=True)
        else:
            candidates = self.storage.files_with_embeddings()
            if file_ids:
                candidates = [c for c in candidates if c.id in file_ids]
            scored: list[tuple[float, SearchHit]] = []
            for record in candidates:
                if record.embedding_vector is None:
                    continue
                score = _cosine_similarity(query_vector, record.embedding_vector)
                scored.append(
                    (
                        score,
                        SearchHit(
                            file_id=record.id,
                            score=score,
                            summary=record.summary,
                            snippet=record.summary[:480] if record.summary else None,
                        ),
                    )
                )
            scored.sort(key=lambda item: item[0], reverse=True)
            hits = [hit for _, hit in scored[: limit * 3]]
        logger.debug(
            "Vector hits for '%s': %s",
            query,
            [(hit.file_id, round(hit.score, 4)) for hit in hits[: min(len(hits), 5)]],
        )
        return hits

    async def _rerank_hits(self: 'SearchEngine', query: str, hits: list[SearchHit], limit: int) -> list[SearchHit]:
        if not hits:
            return []
        try:
            documents: list[str] = []
            for hit in hits:
                chunk_text = self._chunk_text(hit)
                if not chunk_text:
                    # Combine snippet and summary for better context when chunk not available
                    snippet = (hit.snippet or "")
                    summary = (hit.summary or "")
                    if snippet and summary and summary not in snippet:
                        chunk_text = f"{snippet}\n\n{summary}"
                    else:
                        chunk_text = snippet or summary or ""
                documents.append(chunk_text[:settings.max_snippet_length])
            reranked = await self.rerank_client.rerank(query, documents, top_k=min(limit, len(hits)))
            if not reranked:
                return hits[:limit]
            ordered: list[SearchHit] = []
            seen_chunk_ids = set()
            for idx, score in reranked:
                if 0 <= idx < len(hits):
                    hit = hits[idx]
                    chunk_id = hit.chunk_id or hit.file_id
                    # Deduplicate by chunk_id to avoid returning the same chunk multiple times
                    if chunk_id not in seen_chunk_ids:
                        seen_chunk_ids.add(chunk_id)
                        ordered.append(hit.copy(update={"score": score}))
                        if len(ordered) >= limit:
                            break
            if ordered:
                logger.debug(
                    "Reranked hits for '%s': %s",
                    query,
                    [(hit.file_id, round(hit.score, 4)) for hit in ordered[: min(len(ordered), 5)]],
                )
                return ordered
        except Exception:
            logger.debug("Rerank failed; falling back to vector ordering", exc_info=True)
        return hits[:limit]

    def _lexical_backfill(self: 'SearchEngine', query: str, limit: int, file_ids: list[str] | None = None) -> list[SearchHit]:
        """
        Perform lexical (keyword-based) search as a complement to vector search.
        Fetches more candidates than needed to ensure good coverage for RRF fusion.
        """
        # Fetch 3x more results for better RRF blending
        fallback_hits = self.storage.search_snippets(query, limit=limit * 3, file_ids=file_ids)
        if fallback_hits:
            logger.debug(
                "Lexical hits for '%s': %s",
                query,
                [(hit.file_id, round(hit.score, 4)) for hit in fallback_hits[: min(len(fallback_hits), 5)]],
            )
        return fallback_hits

    def _mandatory_first_blend(self: 'SearchEngine', mandatory: list[SearchHit], supplemental: list[SearchHit], limit: int) -> list[SearchHit]:
        """
        Blend results with mandatory hits first (guaranteed inclusion).
        Mandatory hits always appear first, then supplemental hits fill remaining slots.
        Deduplicates by chunk_id.
        """
        blended: list[SearchHit] = []
        seen_chunks: set[str] = set()

        # Add all mandatory hits first
        for hit in mandatory:
            chunk_key = hit.chunk_id or hit.file_id
            if chunk_key not in seen_chunks:
                blended.append(hit)
                seen_chunks.add(chunk_key)

        # Fill remaining slots with supplemental hits
        for hit in supplemental:
            if len(blended) >= limit:
                break
            chunk_key = hit.chunk_id or hit.file_id
            if chunk_key not in seen_chunks:
                blended.append(hit)
                seen_chunks.add(chunk_key)

        logger.debug(f"Mandatory-first blend: {len(mandatory)} mandatory + {len(blended) - len(mandatory)} supplemental")
        return blended

    def _blend_hits(self: 'SearchEngine', primary: list[SearchHit], secondary: list[SearchHit], limit: int) -> list[SearchHit]:
        """
        Blend vector and lexical search results using Reciprocal Rank Fusion (RRF).
        This gives higher weight to results that appear in both rankings.
        """
        if not secondary:
            return primary[:limit]

        # RRF parameters
        k = 60  # Constant to reduce the impact of high ranks

        # Build chunk-level ranking (not file-level)
        chunk_scores: dict[str, float] = {}
        chunk_hits: dict[str, SearchHit] = {}

        # Process primary (vector) results
        for rank, hit in enumerate(primary, start=1):
            chunk_key = hit.chunk_id or hit.file_id
            rrf_score = 1.0 / (k + rank)
            chunk_scores[chunk_key] = chunk_scores.get(chunk_key, 0.0) + rrf_score
            if chunk_key not in chunk_hits:
                chunk_hits[chunk_key] = hit

        # Process secondary (lexical) results with MUCH higher weight for keyword matches
        # Increased from 1.5 to 3.0 to prioritize exact keyword matches
        lexical_boost = 3.0  # Strong boost for lexical results
        for rank, hit in enumerate(secondary, start=1):
            chunk_key = hit.chunk_id or hit.file_id
            rrf_score = lexical_boost / (k + rank)
            chunk_scores[chunk_key] = chunk_scores.get(chunk_key, 0.0) + rrf_score
            if chunk_key not in chunk_hits:
                chunk_hits[chunk_key] = hit

        # Sort by combined RRF score
        sorted_chunks = sorted(chunk_scores.items(), key=lambda x: x[1], reverse=True)

        # Log top blended results for debugging
        logger.debug("RRF blend - top 5 results:")
        for idx, (chunk_key, score) in enumerate(sorted_chunks[:5], 1):
            hit = chunk_hits[chunk_key]
            logger.debug(f"  {idx}. {self._hit_label(hit)[:60]} (RRF={score:.4f})")

        # Build final result list, preserving ORIGINAL scores
        blended: list[SearchHit] = []
        for chunk_key, _ in sorted_chunks[:limit]:
            hit = chunk_hits[chunk_key]
            # Do NOT overwrite score with RRF score. Keep original score.
            # If we want to indicate it's a blended result, we could add metadata,
            # but for "Absolute Value" request, we keep the raw score.
            blended.append(hit)

        return blended

    async def _maybe_rewrite_query(self: 'SearchEngine', query: str) -> QueryRewriteResult:
        clean = query.strip()
        if not clean:
            return QueryRewriteResult(query, query, [], False)
        if not self._should_rewrite(clean):
            return QueryRewriteResult(query, clean, [], False)

        instructions = (
            "Rewrite the user's retrieval query so embeddings capture intent. Respond strictly with JSON in the form "
            '{"primary": "...", "alternates": ["...", "..."]}. Provide two or three diverse phrasings that emphasise different entities or intent cues. '
            "Keep each rewrite under twelve words and avoid repeating the original verbatim unless necessary."
        )
        try:
            messages = [
                {"role": "system", "content": instructions},
                {"role": "user", "content": f"User query: {clean}\nRewrite succinctly."}
            ]
            raw = await self.llm_client.chat_complete(
                messages,
                max_tokens=160,
                temperature=0.2,
            )
            payload = self._coerce_rewrite_payload(raw)
            primary = str(
                payload.get("primary")
                or payload.get("rewrite")
                or payload.get("rewritten")
                or ""
            ).strip()
            alternates_source = payload.get("alternates") or payload.get("alternatives") or payload.get("queries") or []
            if isinstance(alternates_source, str):
                alternates_iterable = [alternates_source]
            elif isinstance(alternates_source, list):
                alternates_iterable = alternates_source
            else:
                alternates_iterable = []
            seen = {clean.lower()}
            if primary:
                seen.add(primary.lower())
            alternates: list[str] = []
            for item in alternates_iterable:
                candidate = str(item or "").strip()
                if not candidate:
                    continue
                lowered = candidate.lower()
                if lowered in seen:
                    continue
                seen.add(lowered)
                alternates.append(candidate)
                if len(alternates) >= 3:
                    break
            effective = primary or clean
            applied = bool(primary and primary.lower() != clean.lower())
            return QueryRewriteResult(query, effective, alternates, applied)
        except Exception:
            logger.debug("Query rewrite skipped; using literal query", exc_info=True)
            return QueryRewriteResult(query, clean, [], False)

    @staticmethod
    def _coerce_rewrite_payload(raw: str) -> dict[str, Any]:
        if not raw:
            return {}
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return {}
        snippet = raw[start: end + 1]
        try:
            data = json.loads(snippet)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            return {}
        return {}

    @staticmethod
    def _should_rewrite(query: str) -> bool:
        if len(query) < 4:
            return False
        reserved_tokens = (":", " AND ", " OR ", "site:")
        if any(token in query for token in reserved_tokens):
            return False
        return True



    async def multi_path_search(
        self: 'SearchEngine', 
        query: str, 
        limit: int | None = None,
        file_ids: list[str] | None = None,
        pre_decomposed: list[str] | None = None,
    ) -> SearchResponse:
        """
        Execute multi-path retrieval:
        1. Decompose query into sub-queries (or use pre_decomposed if provided)
        2. Execute searches in parallel
        3. Merge and deduplicate results
        4. Rerank combined results
        """
        if limit is None:
            limit = settings.search_result_limit
        
        started = time.perf_counter()
        steps = StepRecorder()
        
        # Step 1: Use pre-decomposed sub-queries or decompose via LLM
        decompose_start = time.perf_counter()
        if pre_decomposed and len(pre_decomposed) > 1:
            sub_queries = pre_decomposed
            decompose_duration = 0  # Already done in _analyze_query
            logger.info(f"Using pre-decomposed sub-queries: {sub_queries}")
        else:
            # Use IntentComponent for decomposition
            analysis = await self.intent_component.analyze_query(query)
            sub_queries = analysis.get("sub_queries", [query])
            decompose_duration = int((time.perf_counter() - decompose_start) * 1000)
        
        steps.add(
            id="decompose",
            title="Query decomposition",
            detail=f"Split into {len(sub_queries)} sub-queries",
            queries=sub_queries,
            duration_ms=decompose_duration,
        )
        
        # If only one sub-query, fall back to regular search
        if len(sub_queries) <= 1:
            logger.info("Single sub-query, falling back to regular search")
            return await self.search(sub_queries[0] if sub_queries else query, limit=limit, enable_multi_path=False)
        
        # Step 2: Execute parallel searches
        parallel_start = time.perf_counter()
        
        async def search_sub_query(sq: str) -> tuple[str, list[SearchHit], str]:
            """Execute search for a single sub-query."""
            try:
                result = await self._single_path_search(sq, limit=limit, file_ids=file_ids)
                return (sq, result.hits, result.strategy)
            except Exception as e:
                logger.warning(f"Sub-query search failed for '{sq}': {e}")
                return (sq, [], "error")
        
        # Run all searches in parallel
        tasks = [search_sub_query(sq) for sq in sub_queries]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        parallel_duration = int((time.perf_counter() - parallel_start) * 1000)
        
        # Collect results
        sub_query_results: list[SubQueryResult] = []
        all_hits: list[SearchHit] = []
    async def multi_path_search(
        self: 'SearchEngine', 
        query: str, 
        limit: int | None = None,
        file_ids: list[str] | None = None,
        pre_decomposed: list[str] | None = None,
        resume_token: str | None = None,
        on_step_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> SearchResponse:
        """
        Execute multi-path search using the progressive pipeline.
        
        Steps:
        1. Decompose query (if not done)
        2. Run progressive pipeline (fast method -> verify -> slow method)
        3. Convert results to SearchResponse
        """
        if limit is None:
            limit = settings.search_result_limit
            
        started = time.perf_counter()
        
        # 1. Decompose if needed
        sub_queries_list: list[dict[str, str]] = []
        
        if pre_decomposed:
            sub_queries_list = [{"id": f"sq_{i}", "text": t} for i, t in enumerate(pre_decomposed)]
        else:
            # Use _analyze_query for decomposition
            analysis = await self._analyze_query(query)
            decomposed = analysis.get("sub_queries", [query])
            sub_queries_list = [{"id": f"sq_{i}", "text": t} for i, t in enumerate(decomposed)]

        # 2. Run progressive pipeline
        pipeline_result = await search_pipeline(
            self,
            query,
            sub_queries_list,
            resume_token=resume_token,
            on_step_event=on_step_event,
        )
        
        # 3. Convert to SearchResponse
        sub_results_data = pipeline_result.get("sub_results", [])
        sub_query_results = []
        hits_map: dict[str, SearchHit] = {}
        
        for res in sub_results_data:
            # Convert dict result to SubQueryResult model
            # Note: progressive result structure differs slightly from old SubQueryResult
            # We need to adapt it or use the new fields in SubQueryResult
            
            # Extract hits from method runs
            sq_hits = []
            runs = res.get("runs", [])
            for run in runs:
                for cand in run.get("candidates", []):
                    # Convert Candidate dict to SearchHit
                    meta = cand.get("meta", {})
                    hit = SearchHit(
                        fileId=cand.get("file_id"),
                        score=cand.get("score", 0.5),
                        metadata=meta,
                        chunkId=cand.get("chunk_id"),
                        snippet=cand.get("text_preview"),
                        analysisConfidence=cand.get("score"), # approximate
                    )
                    sq_hits.append(hit)
                    
                    # Add to global unique hits map
                    key = f"{hit.file_id}:{hit.chunk_id}"
                    if key not in hits_map or hit.score > hits_map[key].score:
                        hits_map[key] = hit

            sub_query_results.append(SubQueryResult(
                sub_query=res.get("sub_query", ""),
                hits=sq_hits,
                strategy="progressive",
                sub_query_id=res.get("sub_query_id"),
                best_answer=res.get("best_so_far"),
                best_confidence=res.get("best_conf"),
                needs_user_decision=res.get("needs_user_decision", False),
                decision_options=res.get("decision_options", []),
                resume_token=res.get("resume_token"),
                method_runs=runs,
            ))
            
        # Collect final unique hits
        final_hits = list(hits_map.values())
        final_hits.sort(key=lambda x: x.score, reverse=True)
        final_hits = final_hits[:limit]
        
        latency_ms = int((time.perf_counter() - started) * 1000)
        
        return SearchResponse(
            query=query,
            hits=final_hits,
            strategy="progressive",
            latency_ms=latency_ms,
            sub_queries=[sq["text"] for sq in sub_queries_list],
            sub_query_results=sub_query_results,
            needs_user_decision=pipeline_result.get("needs_user_decision", False),
            resume_token=None, # Overall token if we merge them, currently per sub-query
            # If any sub-query has resume token, we might want to expose it at top level?
            # For now, it's inside sub_query_results, frontend should look there.
        )

    async def _single_path_search(
        self: 'SearchEngine', 
        query: str, 
        limit: int | None = None,
        file_ids: list[str] | None = None,
    ) -> SearchResponse:
        """
        Execute a single-path search (the original search logic).
        This is extracted to be called by multi_path_search for each sub-query.
        """
        if limit is None:
            limit = settings.search_result_limit
        
        started = time.perf_counter()
        rewrite = await self._maybe_rewrite_query(query)
        queries_for_embedding = rewrite.variants(include_original=True, limit=4)
        
        steps = StepRecorder()
        steps.add(
            id="rewrite",
            title="Rewrite queries",
            detail=f"Using {len(queries_for_embedding)} variants",
            queries=queries_for_embedding,
        )
        
        primary_query = queries_for_embedding[0] if queries_for_embedding else query
        
        try:
            embeddings = await self.embedding_client.encode(queries_for_embedding)
        except Exception as exc:
            logger.warning("Embedding service unavailable: %s", exc)
            raise EmbeddingUnavailableError("embedding service unavailable") from exc
        
        if not embeddings:
            return SearchResponse(
                query=query,
                hits=[],
                strategy="vector",
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        
        paired_queries = queries_for_embedding[:len(embeddings)] or [primary_query]
        vector_hits, per_query_hits = self._collect_multi_vector_hits(
            paired_queries, embeddings, limit, file_ids=file_ids
        )
        
        hits = vector_hits
        strategy = "vector"
        
        if hits:
            reranked = await self._rerank_hits(primary_query, hits, limit)
            if reranked:
                hits = reranked
            
            lexical_hits = self._lexical_backfill(primary_query, limit, file_ids=file_ids)
            if lexical_hits:
                hits = self._blend_hits(hits, lexical_hits, limit)
                strategy = "hybrid"
        else:
            lexical_hits = self._lexical_backfill(primary_query, limit, file_ids=file_ids)
            if lexical_hits:
                hits = lexical_hits[:limit]
                strategy = "lexical"
        
        latency_ms = int((time.perf_counter() - started) * 1000)
        return SearchResponse(
            query=query,
            hits=hits[:limit],
            rewritten_query=rewrite.effective if rewrite.applied else None,
            query_variants=rewrite.alternates,
            strategy=strategy,
            latency_ms=latency_ms,
            diagnostics=steps.snapshot(),
        )

    async def search(self: 'SearchEngine', query: str, limit: int | None = None, enable_multi_path: bool = True) -> SearchResponse:
        """
        Enhanced search with multi-path retrieval and mandatory keyword matching:

        1. If query is complex (multi-aspect/comparison) AND enable_multi_path is True:
           → Decompose into sub-queries and search in parallel
           → Merge and rerank results

        2. If query has >= 4 terms AND chunks exist with ALL terms:
           → These chunks MUST appear in results (mandatory inclusion)
           → If not enough, supplement with vector search

        3. Otherwise (< 4 terms or no complete matches):
           → Use standard hybrid search
        """
        if limit is None:
            limit = settings.search_result_limit
        
        # Step 1: Analyze query using LLM to determine if decomposition needed
        analysis = {"needs_decomposition": False}
        if enable_multi_path:
            try:
                analysis = await self._analyze_query(query)
                if analysis.get("needs_decomposition"):
                    logger.info(f"🔀 Using multi-path retrieval (strategy: {analysis.get('strategy', 'unknown')}) for: '{query}'")
                    try:
                        # Pass pre-analyzed sub-queries to avoid duplicate LLM call
                        return await self.multi_path_search(
                            query, 
                            limit=limit, 
                            pre_decomposed=analysis["sub_queries"]
                        )
                    except Exception as e:
                        logger.warning(f"Multi-path search failed, falling back to standard: {e}")
                        # Fall through to standard search
            except Exception as e:
                logger.warning(f"Query analysis failed: {e}, using standard search")
        
        # Note: @filename syntax is only supported in /qa endpoint, not /search
        # For file-specific queries, use the QA endpoint instead
        file_ids_list = None

        started = time.perf_counter()
        rewrite = await self._maybe_rewrite_query(query)
        queries_for_embedding = rewrite.variants(include_original=True, limit=4)
        query_summary = (
            f"Expanded to {len(queries_for_embedding)} variants"
            if len(queries_for_embedding) > 1
            else "Using literal query"
        )

        steps = StepRecorder()
        steps.add(
            id="rewrite",
            title="Rewrite queries",
            detail=query_summary,
            queries=queries_for_embedding,
        )

        primary_query = queries_for_embedding[0] if queries_for_embedding else query

        # Count query terms (exclude very short words)
        query_terms = [term.strip().lower() for term in primary_query.split() if len(term.strip()) >= 2]
        num_terms = len(query_terms)

        # STEP 1: Check for mandatory keyword matching (for complex queries)
        if num_terms >= 4:
            # Complex query - try to find chunks with ALL terms
            mandatory_hits = self.storage.search_snippets(primary_query, limit=limit, require_all_terms=True, file_ids=file_ids_list)

            if mandatory_hits:
                # Found chunks with ALL query terms - these MUST be included
                logger.info(f"Found {len(mandatory_hits)} chunks with ALL {num_terms} terms for '{primary_query}'")

                steps.add(
                    id="mandatory_match",
                    title="Complete keyword match",
                    detail=f"Found {len(mandatory_hits)} chunks containing all {num_terms} query terms",
                    files=self._step_files(mandatory_hits[:limit]),
                )

                if len(mandatory_hits) >= limit:
                    # Enough mandatory hits - just rerank them
                    rerank_started = time.perf_counter()
                    reranked = await self._rerank_hits(primary_query, mandatory_hits, limit)
                    rerank_duration = int((time.perf_counter() - rerank_started) * 1000)

                    if reranked:
                        steps.add(
                            id="rerank",
                            title="Rerank complete matches",
                            detail=f"Reordered {len(reranked)} complete keyword matches",
                            files=self._step_files(reranked),
                            duration_ms=rerank_duration,
                        )
                        hits = reranked[:limit]
                    else:
                        hits = mandatory_hits[:limit]
                    
                    # Deduplicate mandatory hits
                    seen_chunk_ids = set()
                    deduplicated_hits = []
                    for hit in hits:
                        chunk_id = hit.chunk_id or hit.file_id
                        if chunk_id not in seen_chunk_ids:
                            seen_chunk_ids.add(chunk_id)
                            deduplicated_hits.append(hit)
                            if len(deduplicated_hits) >= limit:
                                break
                    hits = deduplicated_hits

                    strategy = "mandatory_keywords"
                    latency_ms = int((time.perf_counter() - started) * 1000)
                    diagnostics = steps.snapshot(summary=f"{len(hits)} file(s) with all {num_terms} keywords")

                    return SearchResponse(
                        query=query,
                        hits=hits,
                        rewritten_query=rewrite.effective if rewrite.applied else None,
                        query_variants=rewrite.alternates,
                        strategy=strategy,
                        latency_ms=latency_ms,
                        diagnostics=diagnostics,
                    )
                else:
                    # Not enough mandatory hits - supplement with vector search
                    logger.info(f"Only {len(mandatory_hits)} complete matches (need {limit}), supplementing with vector search")

                    try:
                        embeddings = await self.embedding_client.encode(queries_for_embedding)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Embedding service unavailable: %s", exc)
                        # Fall back to just mandatory hits
                        hits = mandatory_hits[:limit]
                        strategy = "mandatory_keywords_only"
                        latency_ms = int((time.perf_counter() - started) * 1000)
                        diagnostics = steps.snapshot(summary=f"{len(hits)} file(s) with keywords (no vector)")

                        return SearchResponse(
                            query=query,
                            hits=hits,
                            rewritten_query=rewrite.effective if rewrite.applied else None,
                            query_variants=rewrite.alternates,
                            strategy=strategy,
                            latency_ms=latency_ms,
                            diagnostics=diagnostics,
                        )

                    if embeddings:
                        paired_queries = queries_for_embedding[: len(embeddings)] or [primary_query]
                        vector_hits, per_query_hits = self._collect_multi_vector_hits(paired_queries, embeddings, limit, file_ids=file_ids_list)

                        steps.add(
                            id="vector_supplement",
                            title="Vector supplement",
                            detail=f"Added {len(vector_hits)} vector candidates to supplement",
                            files=self._step_files(vector_hits[:5]),
                        )

                        # Combine: mandatory hits first, then vector hits (deduplicate by chunk_id)
                        combined_hits = self._mandatory_first_blend(mandatory_hits, vector_hits, limit)

                        # Rerank combined results
                        rerank_started = time.perf_counter()
                        reranked = await self._rerank_hits(primary_query, combined_hits, limit)
                        rerank_duration = int((time.perf_counter() - rerank_started) * 1000)

                        if reranked:
                            steps.add(
                                id="rerank",
                                title="Rerank combined results",
                                detail=f"Reranked {len(combined_hits)} candidates (mandatory + vector)",
                                duration_ms=rerank_duration,
                            )
                            hits = reranked[:limit]
                        else:
                            hits = combined_hits[:limit]

                        strategy = "mandatory_plus_vector"
                        latency_ms = int((time.perf_counter() - started) * 1000)
                        diagnostics = steps.snapshot(summary=f"{len(hits)} file(s) (mandatory keywords + vector)")

                        return SearchResponse(
                            query=query,
                            hits=hits,
                            rewritten_query=rewrite.effective if rewrite.applied else None,
                            query_variants=rewrite.alternates,
                            strategy=strategy,
                            latency_ms=latency_ms,
                            diagnostics=diagnostics,
                        )

        # STEP 2: Standard hybrid search (< 4 terms or no complete matches)
        logger.info(f"Using standard hybrid search for '{query}' ({num_terms} terms)")

        try:
            embeddings = await self.embedding_client.encode(queries_for_embedding)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Embedding service unavailable for query '%s': %s", query, exc)
            raise EmbeddingUnavailableError("embedding service unavailable") from exc

        if not embeddings:
            diagnostics = steps.snapshot(summary="Embedding backend returned no vectors")
            return SearchResponse(
                query=query,
                hits=[],
                rewritten_query=rewrite.effective if rewrite.applied else None,
                query_variants=rewrite.alternates,
                strategy="vector",
                latency_ms=int((time.perf_counter() - started) * 1000),
                diagnostics=diagnostics,
            )

        paired_queries = queries_for_embedding[: len(embeddings)] or [primary_query]
        vector_hits, per_query_hits = self._collect_multi_vector_hits(paired_queries, embeddings, limit, file_ids=file_ids_list)
        total_vector_hits = sum(len(entry[1]) for entry in per_query_hits)

        if total_vector_hits:
            steps.add(
                id="vector",
                title="Vector retrieval",
                detail=f"Collected {total_vector_hits} chunks",
                queries=[entry[0] for entry in per_query_hits],
                items=[f"{entry[0][:80]} → {len(entry[1])} hits" for entry in per_query_hits],
                files=self._step_files(vector_hits),
            )

        hits = vector_hits
        strategy = "vector"

        if hits:
            rerank_started = time.perf_counter()
            reranked = await self._rerank_hits(primary_query, hits, limit)
            rerank_duration = int((time.perf_counter() - rerank_started) * 1000)
            if reranked:
                steps.add(
                    id="rerank",
                    title="Rerank matches",
                    detail=f"Reordered top {min(len(reranked), limit)} candidates",
                    files=self._step_files(reranked),
                    duration_ms=rerank_duration,
                )
                hits = reranked
            lexical_hits = self._lexical_backfill(primary_query, limit, file_ids=file_ids_list)
            if lexical_hits:
                steps.add(
                    id="lexical",
                    title="Lexical backfill",
                    detail=f"Added {len(lexical_hits)} snippet matches",
                    files=self._step_files(lexical_hits),
                )
                hits = self._blend_hits(hits, lexical_hits, limit)
                strategy = "hybrid"
        else:
            lexical_hits = self._lexical_backfill(primary_query, limit, file_ids=file_ids_list)
            if lexical_hits:
                steps.add(
                    id="lexical",
                    title="Lexical fallback",
                    detail=f"Served {len(lexical_hits)} snippet matches",
                    files=self._step_files(lexical_hits),
                )
                hits = lexical_hits[:limit]
                strategy = "lexical"

        # Final deduplication: remove duplicate chunks by chunk_id and similar content
        seen_chunk_ids = set()
        seen_content_hashes = set()  # Hash of first 200 chars to detect near-duplicate content
        deduplicated_hits = []
        for hit in hits:
            chunk_id = hit.chunk_id or hit.file_id
            # Check by chunk_id first
            if chunk_id in seen_chunk_ids:
                continue
            
            # Check by content similarity (hash of snippet/first 200 chars)
            content = (hit.snippet or "")[:200] or (hit.summary or "")[:200]
            content_hash = hash(content.strip().lower())
            if content_hash in seen_content_hashes:
                # Skip if we've seen very similar content (likely duplicate chunk from same page)
                continue
            
            seen_chunk_ids.add(chunk_id)
            seen_content_hashes.add(content_hash)
            deduplicated_hits.append(hit)
            if len(deduplicated_hits) >= limit:
                break
        
        latency_ms = int((time.perf_counter() - started) * 1000)
        diagnostics = steps.snapshot(summary=f"{len(deduplicated_hits)} file(s) ready via {strategy} strategy")
        return SearchResponse(
            query=query,
            hits=deduplicated_hits,
            rewritten_query=rewrite.effective if rewrite.applied else None,
            query_variants=rewrite.alternates,
            strategy=strategy,
            latency_ms=latency_ms,
            diagnostics=diagnostics,
        )

    async def stream_search(self: 'SearchEngine', query: str, limit: int = 10) -> AsyncIterable[str]:
        """
        Progressive/layered search that yields results as they become available.
        """
        started = time.perf_counter()
        
        # Step 0: Check for Multi-path (for complex queries)
        try:
            analysis = await self._analyze_query(query)
            if analysis["needs_decomposition"]:
                # If multi-path is needed, we currently fall back to non-streaming 
                # but return the results through the same format for consistency.
                logger.info(f"🔀 [STREAM] Triggering multi-path for complex query")
                multi_path_result = await self.multi_path_search(
                    query, 
                    limit=limit, 
                    pre_decomposed=analysis["sub_queries"]
                )
                
                yield json.dumps({
                    "stage": "multi_path",
                    "hits": [h.model_dump(by_alias=True) for h in multi_path_result.hits],
                    "totalHits": len(multi_path_result.hits),
                    "done": True,
                    "latencyMs": int((time.perf_counter() - started) * 1000),
                }) + "\n"
                return
        except Exception as e:
            logger.warning(f"Multi-path stream analysis failed: {e}")

        seen_file_ids: set[str] = set()
        all_hits: list[SearchHit] = []

        def merge_hits(new_hits: list[SearchHit], stage: str) -> list[SearchHit]:
            """Merge new hits, avoiding duplicates by file_id."""
            merged = []
            for hit in new_hits:
                if hit.file_id not in seen_file_ids:
                    seen_file_ids.add(hit.file_id)
                    # Tag the hit with the stage it was found in
                    hit.metadata = hit.metadata or {}
                    hit.metadata["_search_stage"] = stage
                    merged.append(hit)
                    all_hits.append(hit)
            return merged

        def make_response(stage: str, hits: list[SearchHit], done: bool = False) -> str:
            stage_latency = int((time.perf_counter() - started) * 1000)
            return json.dumps({
                "stage": stage,
                "hits": [h.model_dump(by_alias=True) for h in hits],
                "totalHits": len(all_hits),
                "done": done,
                "latencyMs": stage_latency,
            }) + "\n"

        # ======================================
        # L1: Filename matching (fastest)
        # ======================================
        try:
            filename_hits = self.storage.search_files_by_filename(query, limit=limit)
            new_hits = merge_hits(filename_hits, "filename")
            if new_hits:
                logger.info(f"L1 Filename: found {len(new_hits)} new files for '{query}'")
                yield make_response("filename", new_hits)
        except Exception as e:
            logger.warning(f"L1 Filename search failed: {e}")

        # ======================================
        # L2: Summary search
        # ======================================
        try:
            summary_hits = self.storage.search_files_by_summary(query, limit=limit, exclude_file_ids=seen_file_ids)
            new_hits = merge_hits(summary_hits, "summary")
            if new_hits:
                logger.info(f"L2 Summary: found {len(new_hits)} new files for '{query}'")
                yield make_response("summary", new_hits)
        except Exception as e:
            logger.warning(f"L2 Summary search failed: {e}")

        # ======================================
        # L3: Metadata search
        # ======================================
        try:
            metadata_hits = self.storage.search_files_by_metadata(query, limit=limit, exclude_file_ids=seen_file_ids)
            new_hits = merge_hits(metadata_hits, "metadata")
            if new_hits:
                logger.info(f"L3 Metadata: found {len(new_hits)} new files for '{query}'")
                yield make_response("metadata", new_hits)
        except Exception as e:
            logger.warning(f"L3 Metadata search failed: {e}")

        # ======================================
        # L4: Hybrid vector search (semantic)
        # ======================================
        # Only do hybrid search if we haven't found enough results yet
        if len(all_hits) < limit:
            try:
                # Use existing search method for hybrid search
                search_result = await self.search(query, limit=limit, enable_multi_path=False)
                
                # Filter to new files only and include chunk-level results
                hybrid_new_hits: list[SearchHit] = []
                for hit in search_result.hits:
                    if hit.file_id not in seen_file_ids:
                        seen_file_ids.add(hit.file_id)
                        hit.metadata = hit.metadata or {}
                        hit.metadata["_search_stage"] = "hybrid"
                        hybrid_new_hits.append(hit)
                        all_hits.append(hit)
                    elif hit.chunk_id:
                        # Include chunk-level hits even for existing files
                        hit.metadata = hit.metadata or {}
                        hit.metadata["_search_stage"] = "hybrid"
                        hybrid_new_hits.append(hit)

                if hybrid_new_hits:
                    logger.info(f"L4 Hybrid: found {len(hybrid_new_hits)} new results for '{query}'")
                    yield make_response("hybrid", hybrid_new_hits)

            except EmbeddingUnavailableError:
                logger.warning("L4 Hybrid search skipped: embedding service unavailable")
            except Exception as e:
                logger.warning(f"L4 Hybrid search failed: {e}")

        # Final done message
        total_latency = int((time.perf_counter() - started) * 1000)
        yield json.dumps({
            "stage": "complete",
            "hits": [],
            "totalHits": len(all_hits),
            "done": True,
            "latencyMs": total_latency,
        }) + "\n"
