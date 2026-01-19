from __future__ import annotations
import logging
import json
import time
from typing import Any, Dict, AsyncGenerator
from services.core.config import settings

from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from services.search.engine import SearchEngine
    from services.search.components.intent import IntentComponent
    from services.search.components.synthesis import SynthesisComponent
    from services.search.pipelines.standard import StandardPipeline

logger = logging.getLogger(__name__)

class MultiPathPipeline:
    def __init__(
        self, 
        engine: 'SearchEngine', 
        intent: 'IntentComponent',
        synthesis: 'SynthesisComponent',
        standard_pipeline: 'StandardPipeline'
    ):
        self.engine = engine
        self.intent = intent
        self.synthesis = synthesis
        self.standard_pipeline = standard_pipeline

    async def execute(
        self,
        payload: Any, # QaRequest
        limit: int,
        analysis: dict | None = None,
        target_file_ids: list[str] | None = None,
        cleaned_query: str | None = None,  # Query with @mentions removed
    ) -> AsyncGenerator[str, None]:
        
        # Use cleaned query if provided, otherwise fall back to payload.query
        query = cleaned_query or payload.query
        
        # Execute Multi-Path Standard Search
        sub_queries_list = analysis.get("sub_queries", [query])
        
        # Ensure sub_queries is a list of objects for the UI
        # The UI expects [{id: string, text: string}, ...] or can handle strings if mapped
        # But ThinkingProcess.tsx: metadata.sub_queries!.map((sq, idx) => ... sq.text ...)
        # So we MUST provide objects with a 'text' property.
        formatted_sub_queries = []
        for i, sq in enumerate(sub_queries_list):
            if isinstance(sq, dict):
                 formatted_sub_queries.append(sq)
            else:
                 formatted_sub_queries.append({"id": f"sq_{i}", "text": sq})

        # Start timer
        started = time.perf_counter()

        # Step 1: Decomposition
        yield json.dumps({"type": "status", "data": "progressive_search_start"}) + "\n"
        yield json.dumps({"type": "multi_path_start", "data": {"query": query}}) + "\n"
        
        step_counter = 0
        def next_step_id():
            nonlocal step_counter
            step_counter += 1
            return f"mp_{step_counter}"

        def get_timestamp():
            return int((time.perf_counter() - started) * 1000)

        decomp_id = next_step_id()
        yield json.dumps({
            "type": "thinking_step",
            "data": {
                "id": decomp_id,
                "type": "decompose",
                "title": "Query Decomposition",
                "status": "complete",
                "summary": f"Split into {len(formatted_sub_queries)} sub-queries",
                "metadata": {"sub_queries": formatted_sub_queries},
                "timestamp_ms": get_timestamp()
            }
        }) + "\n"

        all_valid_sub_answers = []
        all_hits = []
        
        # Global tracking across subqueries
        global_chunk_index = 1  # Chunks in SQ2 continue from where SQ1 ended
        seen_chunk_ids = set()  # Prevent duplicate processing across subqueries

        for i, sq_obj in enumerate(formatted_sub_queries):
            sq_text = sq_obj.get("text", str(sq_obj))
            
            # Header for Sub-Query
            sq_step_id = next_step_id()
            yield json.dumps({
                 "type": "thinking_step",
                 "data": {
                     "id": sq_step_id,
                     "type": "subquery",
                     "title": f"Sub-query {i+1}: {sq_text}",
                     "status": "running",
                     "summary": "Executing standard search pipeline...",
                     "subQuery": sq_text,
                     "timestamp_ms": get_timestamp()
                 }
            }) + "\n"

            # Execute Standard Pipeline for Sub-Query
            # We track best answer for this subquery
            current_sq_answers = []

            logger.warning(f"[MP DEBUG] SQ{i+1} calling StandardPipeline with global_start_index={global_chunk_index}")
            async for event in self.standard_pipeline.execute(
                query=sq_text, 
                limit=limit, 
                step_generator=next_step_id,
                title_prefix=f"[SQ{i+1}] ",
                target_file_ids=target_file_ids,  # Scope isolation: pass folder filter
                # NOTE: We do NOT exclude chunks from previous subqueries anymore.
                # Same document may contain answers for multiple subqueries (e.g., 2022 and 2023 data).
                # Each subquery searches independently using its own query terms.
                excluded_chunk_ids=None,
                global_start_index=global_chunk_index,
            ):
                if event["type"] == "sub_answers":
                    for ans in event["data"]:
                        if (ans.get("has_answer") and ans.get("content")):
                             ans["sub_query"] = sq_text # Track origin
                             all_valid_sub_answers.append(ans)
                             current_sq_answers.append(ans)
                elif event["type"] == "hits":
                    # Track chunk count for global indexing (display purposes)
                    new_chunks_in_this_event = 0
                    for h in event["data"]:
                        cid = None
                        if isinstance(h, dict):
                            cid = h.get("chunkId") or h.get("chunk_id")
                        elif hasattr(h, 'chunk_id'):
                            cid = h.chunk_id
                        
                        if cid and cid not in seen_chunk_ids:
                            seen_chunk_ids.add(cid)
                            new_chunks_in_this_event += 1
                    
                    all_hits.extend(event["data"])
                    # Only increment global index for truly new chunks
                    global_chunk_index += new_chunks_in_this_event
                    yield json.dumps(event) + "\n"
                elif event.get("type"):
                    # Pass through thinking steps and other events
                    if event["type"] == "thinking_step":
                         # Ensure timestamps are relative to OUR start time if not already
                         # StandardPipeline uses its own local start time. 
                         # Ideally we want a unified timeline. 
                         # But let's just let it pass through for now, or overwrite timestamp?
                         # Overwriting might be safer for potential clock drift or consistent 0-based
                         # event["data"]["timestamp_ms"] = get_timestamp()
                         yield json.dumps(event) + "\n"
                    elif event["type"] in ["chunk_progress", "status", "chunk_analysis"]:
                         yield json.dumps(event) + "\n"
            
            # Sub-query completion with answer summary
            best_answer = None
            if current_sq_answers:
                # Pick best confidence or first
                best = max(current_sq_answers, key=lambda x: x.get("confidence", 0))
                best_answer = best.get("content")

            yield json.dumps({
                 "type": "thinking_step",
                 "data": {
                     "id": sq_step_id,
                     "type": "subquery",
                     "title": f"Sub-query {i+1}: {sq_text}",
                     "status": "complete",
                     "summary": f"Sub-query processing finished. Found {len(current_sq_answers)} answers." if current_sq_answers else "Sub-query processing finished.",
                     "subQuery": sq_text,
                     "subQueryAnswer": best_answer,
                     "timestamp_ms": get_timestamp()
                 }
            }) + "\n"

        if not all_valid_sub_answers:
             yield json.dumps({"type": "done", "data": "No information found for any sub-queries."}) + "\n"
             return

        # Simple Aggregation / Synthesis
        yield json.dumps({"type": "status", "data": "synthesizing_answer"}) + "\n"
        
        synth_step_id = next_step_id()
        yield json.dumps({
            "type": "thinking_step",
            "data": {
                "id": synth_step_id,
                "type": "synthesize",
                "title": "Final Synthesis",
                "status": "running",
                "summary": "Combining results from all sub-queries...",
                "timestamp_ms": get_timestamp()
            }
        }) + "\n"

        # Prepare list of Dict for synthesis
        synthesis_inputs = []
        for i, ans in enumerate(all_valid_sub_answers):
             synthesis_inputs.append({
                 # Use the original chunk index, not renumbered
                 "index": ans.get("index", i + 1),
                 "source": f"{ans.get('source')} (from '{ans.get('sub_query', '')}')",
                 "content": ans.get("content"),
                 # confidence is optional if not available
                 "confidence": 1.0 
             })
             
        full_response = "" 
        try:
             async for token in self.synthesis.stream_simple_aggregation(query, synthesis_inputs):
                 full_response += token
                 yield json.dumps({"type": "token", "data": token}) + "\n"
        except Exception as e:
            logger.error(f"Synthesis failed: {e}")
            yield json.dumps({"type": "error", "data": str(e)}) + "\n"

        yield json.dumps({
            "type": "thinking_step",
            "data": {
                "id": synth_step_id,
                "type": "synthesize",
                "title": "Final Synthesis",
                "status": "complete",
                "summary": "Answer generated.",
                "timestamp_ms": get_timestamp()
            }
        }) + "\n"
        
        # Don't include full_response in done - tokens were already streamed!
        yield json.dumps({"type": "done"}) + "\n"
