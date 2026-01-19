"""
Progressive Search Pipeline

Executes search methods in order of cost (fast → slow) with:
- Early exit on good answers
- User decision points
- Resume support via tokens
- Verify budget control
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any, Callable, Awaitable

from services.search.types import (
    Candidate,
    VerifiedCandidate,
    VerifyResult,
    MethodRunResult,
    SubQueryProgressiveResult,
    AnswerReadiness,
    RetrievalLimits,
)
from services.search.methods import (
    build_method_list,
    get_method_fn,
)

if TYPE_CHECKING:
    from services.search.engine import SearchEngine

logger = logging.getLogger(__name__)

# Default verify budget per step
VERIFY_BUDGET_PER_STEP = 20


# =============================================================================
# Keyword Extraction
# =============================================================================

# Stop words for rule-based extraction
_STOP_WORDS = {
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'what', 'who', 'where', 'when', 'why',
    'how', 'which', 'this', 'that', 'these', 'those', 'it', 'its', 'of',
    'to', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'or', 'and',
    'about', 'any', 'all', 'some', 'me', 'my', 'your', 'our', 'their',
    'i', 'you', 'we', 'they', 'he', 'she', 'tell', 'show', 'find', 'get',
    'know', 'want', 'need', 'please', 'help', 'give', 'think', 'see',
}


def extract_keywords(query: str) -> list[str]:
    """
    Extract keywords from query using rule-based approach.
    This is the fast, synchronous version used as fallback.
    """
    # Tokenize and filter
    words = re.findall(r'\b\w+\b', query.lower())
    keywords = [w for w in words if w not in _STOP_WORDS and len(w) > 2]
    return keywords[:10]  # Limit to 10 keywords


async def extract_keywords_llm(
    query: str,
    llm_client: Any,
    max_keywords: int = 10,
) -> list[str]:
    """
    Extract keywords using LLM for better semantic understanding.
    
    This extracts:
    - Named entities (people, organizations, products)
    - Technical terms and domain-specific vocabulary
    - Key nouns and important verbs
    - Numbers, dates, and versions
    - Multi-word phrases when meaningful
    
    Falls back to rule-based extraction if LLM fails.
    """
    if not llm_client:
        return extract_keywords(query)
    
    prompt = f"""You are a search query optimizer. Your job is to extract the most important keywords from the user's query for a full-text search engine.

Query: "{query}"

Instructions:
1. Extract named entities (people, companies, products), technical terms, and specific dates/numbers.
2. Keep important multi-word concepts together (e.g. "machine learning").
3. REMOVE all conversational filler words (e.g. "how", "many", "did", "please", "tell", "me").
4. Do NOT include examples from these instructions in your output.
5. Return ONLY a JSON array of strings.

JSON Response:"""

    try:
        result = await llm_client.chat_complete(
            [{"role": "user", "content": prompt}],
            max_tokens=150,
            temperature=0.1,
        )
        
        # Parse JSON array
        result = result.strip()
        # Find JSON array in response
        match = re.search(r'\[.*?\]', result, re.DOTALL)
        if match:
            keywords = json.loads(match.group(0))
            if isinstance(keywords, list) and all(isinstance(k, str) for k in keywords):
                # Clean and dedupe
                cleaned = []
                seen = set()
                for kw in keywords:
                    kw_lower = kw.lower().strip()
                    if kw_lower and kw_lower not in seen and len(kw_lower) > 1:
                        cleaned.append(kw_lower)
                        seen.add(kw_lower)
                if cleaned:
                    logger.debug(f"LLM extracted keywords: {cleaned}")
                    return cleaned[:max_keywords]
    except Exception as e:
        logger.warning(f"LLM keyword extraction failed: {e}")
    
    # Fallback to rule-based
    return extract_keywords(query)


# =============================================================================
# Deduplication & Merge
# =============================================================================

def dedup_and_merge(
    global_pool: list[Candidate],
    new_candidates: list[Candidate],
) -> list[Candidate]:
    """
    Merge new candidates into global pool, deduplicating by file_id + chunk_id.
    """
    seen: dict[str, Candidate] = {}
    
    # Index existing candidates
    for c in global_pool:
        key = f"{c.file_id}:{c.chunk_id or 'file'}"
        seen[key] = c
    
    # Merge new candidates
    for c in new_candidates:
        key = f"{c.file_id}:{c.chunk_id or 'file'}"
        if key in seen:
            # Merge matched_routes
            existing = seen[key]
            for route in c.matched_routes:
                if route not in existing.matched_routes:
                    existing.matched_routes.append(route)
            # Update score if higher
            if c.score > existing.score:
                existing.score = c.score
        else:
            seen[key] = c
    
    return list(seen.values())


# =============================================================================
# Pre-Rerank (simple scoring)
# =============================================================================

def pre_rerank(
    candidates: list[Candidate],
    query: str,
    top_n: int = VERIFY_BUDGET_PER_STEP,
) -> list[Candidate]:
    """
    Quick pre-rerank before LLM verify.
    Uses route count and score as signals.
    """
    def score_fn(c: Candidate) -> float:
        # Boost for matching multiple routes
        route_boost = len(c.matched_routes) * 0.1
        return c.score + route_boost
    
    sorted_cands = sorted(candidates, key=score_fn, reverse=True)
    return sorted_cands[:top_n]


# =============================================================================
# LLM Verification
# =============================================================================

async def lm_verify(
    engine: 'SearchEngine',
    sub_question: str,
    evidence_text: str,
    evidence_meta: dict[str, Any],
) -> VerifyResult:
    """
    Use LLM to verify if evidence answers the sub-question.
    Returns VerifyResult with confidence and extracted answer.
    """
    # Simple prompt for 2B model
    system_prompt = """Does the text answer the question? Respond in JSON:
{"answerable": true/false, "confidence": 0.0-1.0, "answer": "...", "reason": "..."}"""

    user_prompt = f"""Question: {sub_question}

Text: {evidence_text[:1500]}

JSON response:"""

    try:
        result = await engine.llm_client.chat_complete(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            max_tokens=200,
            temperature=0.1,
        )
        
        # Parse JSON
        result = result.strip()
        json_match = re.search(r'\{[^{}]*\}', result, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group(0))
            return VerifyResult(
                is_relevant=parsed.get("answerable", False),
                answerable=parsed.get("answerable", False),
                confidence=float(parsed.get("confidence", 0.0)),
                evidence_quote=evidence_text[:200],
                extracted_answer=parsed.get("answer"),
                reason=parsed.get("reason"),
            )
    except Exception as e:
        logger.warning(f"LM verify failed: {e}")
    
    return VerifyResult(
        is_relevant=False,
        answerable=False,
        confidence=0.0,
        reason="Verification failed",
    )


async def verify_candidates_batch(
    engine: 'SearchEngine',
    sub_question: str,
    candidates: list[Candidate],
    budget: int = VERIFY_BUDGET_PER_STEP,
    on_step_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    sub_query_id: str | None = None,
) -> tuple[list[VerifiedCandidate], Any]:
    """
    Verify candidates against sub-question with budget limit.
    Uses engine._process_single_chunk for consistent logic with single-path.
    Emits verify_progress events.
    """
    verified: list[VerifiedCandidate] = []
    candidates_to_process = candidates[:budget]
    total = len(candidates_to_process)
    
    for i, c in enumerate(candidates_to_process):
        # 1. Adapt Candidate to context_part format expected by _process_single_chunk
        context_part = {
            "index": i + 1,
            "source": c.file_id,
            "content": c.text_preview,
            "score": c.score,
            "file_id": c.file_id,
            "chunk_id": c.chunk_id,
            "metadata": c.meta.to_dict() if hasattr(c.meta, 'to_dict') else (c.meta or {}),
        }

        # 2. Reuse efficient single-chunk processor
        # sub_question is passed as 'query'
        result = await engine._process_single_chunk(sub_question, context_part)
        
        # 3. Map result back to VerifyResult
        v_result = VerifyResult(
            is_relevant=result.get("has_answer", False),
            answerable=result.get("has_answer", False),
            confidence=result.get("confidence", 0.0),
            extracted_answer=result.get("content"),
            evidence_quote=c.text_preview[:200], # _process_single_chunk doesn't extract quote separate from answer usually
            reason="Verified by _process_single_chunk"
        )

        verified.append(VerifiedCandidate(
            candidate=c,
            verify=v_result,
        ))

        # 4. Emit progress event
        if on_step_event and sub_query_id:
            await on_step_event({
                "type": "verify_progress",
                "sub_query_id": sub_query_id,
                "current": i + 1,
                "total": total,
                "candidate": {
                     "chunk_id": c.chunk_id,
                     "file_id": c.file_id,
                     "score": round(c.score, 3),
                     "snippet": (c.text_preview or "")[:150],
                },
                "result": {
                     "is_relevant": v_result.is_relevant,
                     "confidence": v_result.confidence,
                     "extracted_answer": v_result.extracted_answer,
                }
            })
    
    return verified, None


# =============================================================================
# Answer Aggregation & Synthesis
# =============================================================================

def aggregate_evidence(verified: list[VerifiedCandidate]) -> list[VerifiedCandidate]:
    """
    Collect all relevant chunks that can contribute to the answer.
    Returns top answerable chunks sorted by confidence.
    """
    relevant = [v for v in verified if v.verify.answerable and v.verify.confidence > 0.3]
    # Sort by confidence descending
    relevant.sort(key=lambda v: v.verify.confidence, reverse=True)
    return relevant[:10]  # Max 10 chunks for synthesis


async def synthesize_answer(
    engine: 'SearchEngine',
    sub_question: str,
    evidence_chunks: list[VerifiedCandidate],
) -> tuple[str | None, str, float]:
    """
    Synthesize a combined answer from multiple evidence chunks.
    LLM estimates the answer quality (good/partial/no).
    
    Returns:
        (answer, status, confidence)
    """
    if not evidence_chunks:
        return None, AnswerReadiness.NO_ANSWER, 0.0
    
    # If only one chunk, infer status from its confidence
    if len(evidence_chunks) == 1:
        v = evidence_chunks[0].verify
        status = AnswerReadiness.NO_ANSWER
        if v.confidence >= AnswerReadiness.GOOD_THRESHOLD:
            status = AnswerReadiness.GOOD_ANSWER
        elif v.confidence >= AnswerReadiness.PARTIAL_THRESHOLD:
            status = AnswerReadiness.PARTIAL_ANSWER
        return v.extracted_answer, status, v.confidence
    
    # Combine evidence from multiple chunks with relevance indicators
    evidence_texts = []
    for i, vc in enumerate(evidence_chunks[:8], 1):  # Increased to 8
        relevance = "High" if vc.verify.confidence > 0.7 else "Low"
        chunk_answer = vc.verify.extracted_answer or vc.verify.evidence_quote or ""
        evidence_texts.append(f"[{i}] ({relevance} Confidence): {chunk_answer}")
    
    combined_evidence = "\n".join(evidence_texts)
    
    # Synthesis prompt with status estimation
    system_prompt = """Combine the evidence to answer the question.
Determine if the answer is 'good_answer' (complete), 'partial_answer', or 'no_answer'.
Format: {"answer": "...", "status": "good_answer", "confidence": 0.8}"""

    user_prompt = f"""Question: {sub_question}

Evidence:
{combined_evidence}

JSON response:"""

    try:
        result = await engine.llm_client.chat_complete(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            max_tokens=400,
            temperature=0.1,
        )
        
        # Parse JSON
        result = result.strip()
        json_match = re.search(r'\{[^{}]*\}', result, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group(0))
            answer = parsed.get("answer", "")
            status = parsed.get("status", AnswerReadiness.PARTIAL_ANSWER)
            conf = float(parsed.get("confidence", 0.5))
            
            # Normalize status string
            if "good" in status.lower():
                status = AnswerReadiness.GOOD_ANSWER
            elif "partial" in status.lower():
                status = AnswerReadiness.PARTIAL_ANSWER
            else:
                status = AnswerReadiness.NO_ANSWER
                
            return answer, status, conf
    except Exception as e:
        logger.warning(f"Answer synthesis failed: {e}")
    
    # Fallback: return best single answer
    best = max(evidence_chunks, key=lambda v: v.verify.confidence)
    status = AnswerReadiness.NO_ANSWER
    if best.verify.confidence >= AnswerReadiness.GOOD_THRESHOLD:
        status = AnswerReadiness.GOOD_ANSWER
    elif best.verify.confidence >= AnswerReadiness.PARTIAL_THRESHOLD:
        status = AnswerReadiness.PARTIAL_ANSWER
        
    return best.verify.extracted_answer, status, best.verify.confidence


async def check_answer_ready(
    engine: 'SearchEngine',
    sub_question: str,
    verified: list[VerifiedCandidate],
) -> tuple[str, float, str | None]:
    """
    Check if we have a satisfactory answer by synthesizing evidence.
    
    Returns:
        (status, best_conf, synthesized_answer)
    """
    # 1. Aggregate relevant evidence
    evidence_chunks = aggregate_evidence(verified)
    
    if not evidence_chunks:
        return AnswerReadiness.NO_ANSWER, 0.0, None
    
    # 2. Synthesize combined answer with status estimation
    answer, status, conf = await synthesize_answer(
        engine, sub_question, evidence_chunks
    )
    
    if not answer:
        return AnswerReadiness.NO_ANSWER, 0.0, None
    
    return status, conf, answer


# =============================================================================
# Resume Token
# =============================================================================

def make_resume_token(
    sub_query_id: str,
    last_method: str,
    global_pool_keys: list[str],
) -> str:
    """Create a resume token for continuing search."""
    data = {
        "sq_id": sub_query_id,
        "last_method": last_method,
        "pool_keys": global_pool_keys[:100],  # Limit size
    }
    return base64.b64encode(json.dumps(data).encode()).decode()


def parse_resume_token(token: str) -> dict[str, Any]:
    """Parse a resume token."""
    try:
        data = json.loads(base64.b64decode(token.encode()).decode())
        return data
    except:
        return {}


# =============================================================================
# Progressive Search Pipeline
# =============================================================================

async def search_one_subquery_progressive(
    engine: 'SearchEngine',
    user_query: str,
    sub_query_id: str,
    sub_query_text: str,
    resume_from: str | None = None,
    user_opted_in_methods: list[str] | None = None,
    on_step_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> SubQueryProgressiveResult:
    """
    Run progressive search for a single sub-query.
    
    Executes methods fast → slow, with early exit on good answers.
    Returns result with user decision point if good answer found.
    """
    started = time.perf_counter()
    
    # Extract keywords using LLM for better semantic understanding
    # Falls back to rule-based if LLM unavailable
    try:
        llm_client = getattr(engine, 'llm_client', None)
        keywords = await extract_keywords_llm(sub_query_text, llm_client)
    except Exception as e:
        logger.warning(f"LLM keyword extraction failed, using fallback: {e}")
        keywords = extract_keywords(sub_query_text)
    
    # Emit keywords extracted event
    if on_step_event:
        await on_step_event({
            "type": "keywords_extracted",
            "sub_query_id": sub_query_id,
            "sub_query": sub_query_text,
            "keywords": keywords
        })
    
    # Get method list
    methods = build_method_list()
    
    # Parse resume token if provided
    start_from_idx = 0
    global_pool: list[Candidate] = []
    if resume_from:
        resume_data = parse_resume_token(resume_from)
        last_method = resume_data.get("last_method")
        # Find index of last method and start from next
        for i, m in enumerate(methods):
            if m.name == last_method:
                start_from_idx = i + 1
                break
    
    # Track all method runs
    run_logs: list[MethodRunResult] = []
    
    # Run methods in order
    for i, method in enumerate(methods):
        if i < start_from_idx:
            continue
            
        if not method.enabled:
            continue
        
        # Check opt-in requirement
        if method.requires_user_opt_in:
            if not user_opted_in_methods or method.name not in user_opted_in_methods:
                run_logs.append(MethodRunResult(
                    method_name=method.name,
                    candidates=[],
                    verified=[],
                    status="skipped_need_opt_in",
                    best_conf=0.0,
                    best_answer=None,
                ))
                continue
        
        method_start = time.perf_counter()
        
        # 1) Run search method
        method_fn = get_method_fn(method.name)

        if on_step_event:
            await on_step_event({
                "type": "method_start",
                "method": method.display_name,
                "sub_query_id": sub_query_id,
                "sub_query": sub_query_text
            })

        new_candidates = await method_fn(
            engine,
            sub_query_text,
            keywords,
            None,  # filters
            method.top_k,
        )
        
        # Set sub_question_id on new candidates
        for c in new_candidates:
            c.sub_question_id = sub_query_id
        
        # Emit candidates found event with rich chunk data
        if on_step_event and new_candidates:
            await on_step_event({
                "type": "candidates_found",
                "method": method.display_name,
                "sub_query_id": sub_query_id,
                "count": len(new_candidates),
                "candidates": [
                    {
                        "chunk_id": c.chunk_id,
                        "file_id": c.file_id,
                        "score": round(c.score, 3),
                        "snippet": (c.text_preview or "")[:150],
                        "metadata": c.meta.to_dict() if hasattr(c.meta, 'to_dict') else (c.meta or {})
                    }
                    for c in new_candidates[:10]  # Limit to top 10
                ]
            })
        
        # 2) Merge into global pool
        global_pool = dedup_and_merge(global_pool, new_candidates)
        
        # 3) Pre-rerank with budget
        shortlist = pre_rerank(global_pool, sub_query_text, VERIFY_BUDGET_PER_STEP)
        
        # Emit verify start
        if on_step_event:
            await on_step_event({
                "type": "verify_start",
                "sub_query_id": sub_query_id,
                "method": method.name,
                "candidate_count": len(shortlist)
            })
        
        # 4) Verify using sub-question (NOT keywords)
        # Use on_step_event for streaming progress
        verified, debug_info = await verify_candidates_batch(
            engine,
            sub_query_text,
            shortlist,
            VERIFY_BUDGET_PER_STEP,
            on_step_event=on_step_event,
            sub_query_id=sub_query_id,
        )
        
        # Emit verification results with chunk details
        if on_step_event and verified:
            await on_step_event({
                "type": "verify_end",
                "sub_query_id": sub_query_id,
                "method": method.name,
                "verified_count": len(verified),
                "results": [
                    {
                        "chunk_id": v.candidate.chunk_id,
                        "file_id": v.candidate.file_id,
                        "confidence": round(v.verify.confidence, 3),
                        "is_relevant": v.verify.confidence >= 0.5,
                        "extracted_answer": (v.verify.extracted_answer or "")[:100],
                        "snippet": (v.candidate.text_preview or "")[:100]
                    }
                    for v in verified[:10]
                ]
            })
        
        # 5) Check answer readiness (aggregate + synthesize + final verify)
        status, best_conf, best_answer = await check_answer_ready(
            engine, sub_query_text, verified
        )
        
        method_duration = int((time.perf_counter() - method_start) * 1000)
        
        run_logs.append(MethodRunResult(
            method_name=method.name,
            candidates=new_candidates,
            verified=verified,
            status=status,
            best_conf=best_conf,
            best_answer=best_answer,
            duration_ms=method_duration,
        ))

        if on_step_event:
            await on_step_event({
                "type": "method_end",
                "method": method.display_name,
                "candidates": len(new_candidates),
                "verified": len(verified),
                "status": status,
                "confidence": best_conf,
                "sub_query_id": sub_query_id,
                "best_answer": best_answer
            })
        
        # 6) EARLY EXIT: good_answer found
        if status == AnswerReadiness.GOOD_ANSWER:
            # Create resume token for optional continuation
            pool_keys = [f"{c.file_id}:{c.chunk_id}" for c in global_pool]
            resume_token = make_resume_token(sub_query_id, method.name, pool_keys)
            
            return SubQueryProgressiveResult(
                sub_query_id=sub_query_id,
                sub_query=sub_query_text,
                keywords=keywords,
                runs=run_logs,
                global_pool_size=len(global_pool),
                best_so_far=best_answer,
                best_conf=best_conf,
                needs_user_decision=True,
                decision_options=["use_current_results", "continue_search"],
                resume_token=resume_token,
            )
        
        # 7) Continue if partial or no answer (can add policy for partial pause)
    
    # All methods finished, produce final result
    # Aggregate best answer from all runs
    final_best_conf = 0.0
    final_best_answer = None
    for run in run_logs:
        if run.best_conf > final_best_conf:
            final_best_conf = run.best_conf
            final_best_answer = run.best_answer
    
    total_duration = int((time.perf_counter() - started) * 1000)
    logger.info(f"Progressive search for '{sub_query_text}' completed in {total_duration}ms with {len(global_pool)} candidates")
    
    return SubQueryProgressiveResult(
        sub_query_id=sub_query_id,
        sub_query=sub_query_text,
        keywords=keywords,
        runs=run_logs,
        global_pool_size=len(global_pool),
        best_so_far=final_best_answer,
        best_conf=final_best_conf,
        needs_user_decision=False,
    )


# =============================================================================
# Main Entry Point
# =============================================================================

async def search_pipeline(
    engine: 'SearchEngine',
    user_query: str,
    sub_queries: list[dict[str, str]],  # [{"id": "...", "text": "..."}]
    resume_token: str | None = None,
    on_step_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """
    Main search pipeline entry point.
    
    Runs progressive search for each sub-query.
    """
    all_sub_results: list[SubQueryProgressiveResult] = []
    
    # Emit decomposition event
    if on_step_event:
        await on_step_event({
            "type": "decompose_complete",
            "query": user_query,
            "sub_queries": [{"id": sq["id"], "text": sq["text"]} for sq in sub_queries]
        })
    
    # Parse resume token to find which sub-query to resume
    resume_sq_id = None
    if resume_token:
        try:
            data = parse_resume_token(resume_token)
            resume_sq_id = data.get("sq_id")
        except:
            pass
    
    for sq in sub_queries:
        # Only pass token to the specific sub-query it belongs to
        token = resume_token if sq["id"] == resume_sq_id else None
        
        # Emit subquery start
        if on_step_event:
            await on_step_event({
                "type": "subquery_start",
                "sub_query_id": sq["id"],
                "sub_query": sq["text"]
            })
        
        sq_result = await search_one_subquery_progressive(
            engine,
            user_query,
            sq["id"],
            sq["text"],
            resume_from=token,
            on_step_event=on_step_event,
        )
        all_sub_results.append(sq_result)
        
        # Emit subquery end
        if on_step_event:
            await on_step_event({
                "type": "subquery_end",
                "sub_query_id": sq["id"],
                "status": sq_result.best_conf > 0.5 and "found" or "searching",
                "best_answer": sq_result.best_so_far,
                "confidence": sq_result.best_conf,
                "needs_decision": sq_result.needs_user_decision
            })
        
        # If any sub-query needs user decision, return early
        if sq_result.needs_user_decision:
            break
    
    return {
        "query": user_query,
        "sub_results": [r.to_dict() for r in all_sub_results],
        "needs_user_decision": any(r.needs_user_decision for r in all_sub_results),
    }
