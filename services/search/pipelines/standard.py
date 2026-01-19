from __future__ import annotations
import logging
import time
from typing import Any, Dict, List, Callable, AsyncGenerator, TYPE_CHECKING
from services.core.config import settings
from services.search.types import EmbeddingUnavailableError

if TYPE_CHECKING:
    from services.search.engine import SearchEngine
    from services.search.components.verification import VerificationComponent

logger = logging.getLogger(__name__)

class StandardPipeline:
    def __init__(self, engine: 'SearchEngine', verification: 'VerificationComponent'):
        self.engine = engine
        self.verification = verification

    async def _process_hits_generator(
        self,
        query: str,
        hits: List[Any],
        step_generator: Callable[[], str],
        started_time: float,
        start_index: int = 1
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Helper generator to process a batch of hits.
        """
        def thinking_step(step_id, step_type, title, status="running", summary=None, details=None, hits=None, **kwargs):
            data = {
                "id": step_id,
                "type": step_type,
                "title": title,
                "status": status,
                "summary": summary,
                "details": details,
                "timestamp_ms": int((time.perf_counter() - started_time) * 1000), 
            }
            if hits:
                data["hits"] = hits
            data.update(kwargs)
            return {"type": "thinking_step", "data": data}

        if not hits:
            return

        # Inject indices
        for i, hit in enumerate(hits):
            if hit.metadata is None: hit.metadata = {}
            hit.metadata["index"] = start_index + i

        yield {"type": "hits", "data": [hit.dict() for hit in hits]}
        yield {"type": "status", "data": "processing_chunks"}

        # Build context parts
        context_parts = []
        for i, hit in enumerate(hits):
             idx = start_index + i
             chunk_text = self.engine._chunk_text(hit)
             
             kind = hit.metadata.get("kind") if hit.metadata else None
             if kind == "image":
                parts = []
                if hit.summary: parts.append(f"[Image Description]: {hit.summary}")
                if chunk_text: parts.append(f"[Image Text]: {chunk_text}")
                snippet = "\n".join(parts)
                if not snippet: snippet = hit.snippet
             else:
                snippet = chunk_text or hit.snippet or hit.summary

             if snippet:
                source = hit.metadata.get("path") if hit.metadata else None
                label = source or hit.file_id
                context_parts.append({
                    "index": idx,
                    "source": label,
                    "content": snippet[:settings.max_snippet_length],
                    "score": hit.score if hasattr(hit, 'score') else 0.0,
                    "file_id": hit.file_id,
                    "chunk_id": hit.chunk_id,
                    "metadata": hit.metadata, 
                })

        # Relevance Filter
        filtered_parts = await self.verification.filter_relevant_chunks(query, context_parts)

        if len(filtered_parts) < len(context_parts):
            filtered_indices = {p.get("index") for p in filtered_parts}
            filtered_hits = [hit for i, hit in enumerate(hits) if (start_index + i) in filtered_indices]
            yield {"type": "hits", "data": [hit.dict() for hit in filtered_hits]}
            
            rerank_step_id = step_generator()
            yield thinking_step(
                rerank_step_id, "analyze", "Relevance Filtering", "complete",
                f"Filtered to {len(filtered_parts)} relevant chunks",
                metadata={"resultsCount": len(filtered_parts), "relevantCount": len(filtered_parts)}
            )

        yield {"type": "status", "data": f"analyzing_{len(filtered_parts)}_chunks"}

        # Sequential Chunk Verification
        sub_answers = []
        chunk_analysis = []
        high_quality_count = 0
        total_parts = len(filtered_parts)

        for i, part in enumerate(filtered_parts):
            result = await self.verification.process_single_chunk(query, part)
            sub_answers.append(result)
            if result.get("has_answer"):
                high_quality_count += 1
            
            anaysis_res = {
                "index": result.get("index"),
                "has_answer": result.get("has_answer", False),
                "comment": result.get("content", "") or None,
                "confidence": result.get("confidence", 0.0),
                "source": result.get("source", ""),
                "file_id": part.get("file_id", ""),
                "chunk_id": part.get("chunk_id", ""),
                "metadata": part.get("metadata"),
            }
            chunk_analysis.append(anaysis_res)

            yield {
                "type": "chunk_progress",
                "data": {
                    "processed_count": i + 1,
                    "total_count": total_parts,
                    "high_quality_count": high_quality_count,
                    "is_last": (i == total_parts - 1),
                    "current_file": part.get("source", "unknown"),
                    "chunk_result": anaysis_res
                }
            }

        yield {"type": "chunk_analysis", "data": chunk_analysis}
        yield {"type": "sub_answers", "data": sub_answers}


    async def execute(
        self,
        query: str,
        limit: int,
        step_generator: Callable[[], str],
        title_prefix: str = "",
        target_file_ids: List[str] | None = None,
        keywords: List[str] | None = None,
        excluded_chunk_ids: set | None = None,
        global_start_index: int = 1,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Execute the standard single-path search pipeline.
        Iterative approach: Keyword Search -> Verify -> (If needed) Semantic Search -> Verify.
        """
        started = time.perf_counter()
        
        def thinking_step(step_id, step_type, title, status="running", summary=None, details=None, hits=None, **kwargs):
            if title_prefix:
                title = f"{title_prefix}{title}"
            
            data = {
                "id": step_id,
                "type": step_type,
                "title": title,
                "status": status,
                "summary": summary,
                "details": details,
                "timestamp_ms": int((time.perf_counter() - started) * 1000),
            }
            if hits:
                data["hits"] = hits
            data.update(kwargs)
            return {"type": "thinking_step", "data": data}

        # Local set for chunks processed in THIS execution (to avoid re-processing semantic hits)
        local_processed_chunk_ids = set()
        # Include any globally excluded chunks from previous subqueries
        all_excluded = excluded_chunk_ids or set()
        total_good_answers = 0
        current_index = global_start_index  # Track the current global index
        logger.warning(f"[DEDUP DEBUG] StandardPipeline starting with global_start_index={global_start_index}, excluded_count={len(all_excluded)}")

        # Step 1: Keyword Search
        keyword_step_id = step_generator()
        yield thinking_step(
            keyword_step_id, "search", "Keyword Search", "running",
            f"Searching for: {', '.join(keywords[:5]) if keywords else query}",
            metadata={"keywords": keywords}
        )
        
        keyword_hits = []
        try:
            fts_query = " ".join(keywords) if keywords else query
            raw_keyword_hits = self.engine.storage.search_snippets_fts(fts_query, limit=limit * 2, file_ids=target_file_ids)
            # Filter out already-processed chunks from previous subqueries
            keyword_hits = [h for h in raw_keyword_hits if h.chunk_id not in all_excluded][:limit]
        except Exception as e:
            logger.warning(f"Keyword search failed: {e}")

        hits_data = [h.model_dump(by_alias=True) for h in keyword_hits]
        yield thinking_step(
            keyword_step_id, "search", "Keyword Search", "complete",
            f"Found {len(keyword_hits)} matches via keyword search",
            metadata={"keywords": keywords},
            hits=hits_data
        )

        # Process Keyword Hits IMMEDIATELY
        if keyword_hits:
            async for event in self._process_hits_generator(query, keyword_hits, step_generator, started, start_index=current_index):
                if event["type"] == "sub_answers":
                    # Count good answers to decide early stop
                    results = event["data"]
                    good_count = sum(1 for r in results if r.get("has_answer"))
                    total_good_answers += good_count
                    
                    # Track processed chunk IDs for semantic dedup within this execution
                    for h in keyword_hits:
                        local_processed_chunk_ids.add(h.chunk_id)
                
                yield event
            
            # Advance the global index counter
            current_index += len(keyword_hits)

        # Check Early Stop
        if total_good_answers >= 1:
             return

        # Not enough answers? Continue to Semantic Search.
        semantic_step_id = step_generator()
        yield thinking_step(
            semantic_step_id, "search", "Semantic Search", "running",
            "Keyword search yielded insufficient results. Searching by meaning..."
        )
        
        semantic_hits = []
        try:
            rewrite = await self.engine._maybe_rewrite_query(query)
            queries = rewrite.variants(include_original=True, limit=4)
            embeddings = await self.engine.embedding_client.encode(queries)
            
            if embeddings:
                semantic_hits, _ = self.engine._collect_multi_vector_hits(
                    queries[:len(embeddings)], embeddings, limit, file_ids=target_file_ids
                )
        except EmbeddingUnavailableError:
             yield thinking_step(semantic_step_id, "search", "Semantic Search", "error", "Embedding service unavailable")
        except Exception as e:
            logger.warning(f"Semantic search failed: {e}")
        
        # Filter Semantic Hits (exclude already processed in this execution AND globally excluded)
        combined_exclusions = local_processed_chunk_ids | all_excluded
        unique_semantic_hits = [h for h in semantic_hits if h.chunk_id not in combined_exclusions]
        
        hits_data = [h.model_dump(by_alias=True) for h in unique_semantic_hits]
        yield thinking_step(
            semantic_step_id, "search", "Semantic Search", "complete",
            f"Found {len(unique_semantic_hits)} new matches via Vector Search",
            hits=hits_data
        )

        if not unique_semantic_hits:
             if total_good_answers == 0:
                 yield {"type": "status", "data": "no_results"}
                 yield {"type": "done_internal", "data": "No matching files found."}
             return

        # Process Semantic Hits
        # Continue index from global counter
        async for event in self._process_hits_generator(query, unique_semantic_hits, step_generator, started, start_index=current_index):
             yield event
        
        # Note: current_index is not returned, but caller tracks via len(hits) returned
