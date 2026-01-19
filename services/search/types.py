from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, List, Literal
import logging
from services.core.models import AgentStep, AgentStepFile, AgentDiagnostics

logger = logging.getLogger(__name__)


# =============================================================================
# FileMenuSystem Search Pipeline Types
# =============================================================================

@dataclass
class SubQuestion:
    """A decomposed sub-question from the user query."""
    id: str
    question: str  # Semantically complete, can be asked directly
    intent: str | None = None  # find_file, fact_lookup, timeline, summary, comparison, who_what_where
    constraints: dict[str, Any] | None = None  # time_range, file_types, path_scope

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "question": self.question,
            "intent": self.intent,
            "constraints": self.constraints,
        }


@dataclass
class RetrievalQuery:
    """Queries for retrieval routes."""
    dense_query: str  # For vector search (sub-question + light rewrite)
    sparse_query: str  # Keywords for BM25/fulltext
    metadata_filters: dict[str, Any] | None = None  # time, filetype, path, owner

    def to_dict(self) -> dict[str, Any]:
        return {
            "dense_query": self.dense_query,
            "sparse_query": self.sparse_query,
            "metadata_filters": self.metadata_filters,
        }


@dataclass
class CandidateMeta:
    """Metadata for a retrieval candidate."""
    path: str | None = None
    filetype: str | None = None
    modified_time: str | None = None
    author: str | None = None
    source_fields_used: list[str] | None = None  # e.g., ["ocr_text", "extracted_text", "filename"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "filetype": self.filetype,
            "modified_time": self.modified_time,
            "author": self.author,
            "source_fields_used": self.source_fields_used,
        }


@dataclass
class Candidate:
    """A candidate from any retrieval route."""
    sub_question_id: str
    route: Literal["vector", "fulltext", "metadata", "hybrid"]
    query_used: str  # The query used for this route
    file_id: str
    chunk_id: str | None
    text_preview: str  # Truncated for frontend display
    score: float
    meta: CandidateMeta | dict[str, Any]
    matched_routes: list[str] = field(default_factory=list)  # For deduplication tracking

    def to_dict(self) -> dict[str, Any]:
        meta_dict = self.meta.to_dict() if isinstance(self.meta, CandidateMeta) else self.meta
        return {
            "sub_question_id": self.sub_question_id,
            "route": self.route,
            "query_used": self.query_used,
            "file_id": self.file_id,
            "chunk_id": self.chunk_id,
            "text_preview": self.text_preview,
            "score": self.score,
            "meta": meta_dict,
            "matched_routes": self.matched_routes,
        }


@dataclass
class VerifyResult:
    """Result of semantic verification against a sub-question."""
    is_relevant: bool
    answerable: bool
    confidence: float  # 0.0 to 1.0
    evidence_quote: str | None = None
    extracted_answer: str | None = None
    reason: str | None = None  # Required when answerable=False

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_relevant": self.is_relevant,
            "answerable": self.answerable,
            "confidence": self.confidence,
            "evidence_quote": self.evidence_quote,
            "extracted_answer": self.extracted_answer,
            "reason": self.reason,
        }


@dataclass
class VerifiedCandidate:
    """A candidate with verification result."""
    candidate: Candidate
    verify: VerifyResult

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate": self.candidate.to_dict(),
            "verify": self.verify.to_dict(),
        }


@dataclass
class DebugStep:
    """A single step in the retrieval/verification pipeline for visualization."""
    step_type: Literal["decompose", "keyword_extract", "retrieval", "merge", "verify", "answer"]
    sub_question_id: str | None = None
    route: Literal["vector", "fulltext", "metadata", "hybrid"] | None = None
    query_used: str | None = None
    candidates: list[Candidate] | None = None
    verified_candidates: list[VerifiedCandidate] | None = None
    metadata: dict[str, Any] | None = None
    duration_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_type": self.step_type,
            "sub_question_id": self.sub_question_id,
            "route": self.route,
            "query_used": self.query_used,
            "candidates": [c.to_dict() for c in self.candidates] if self.candidates else None,
            "verified_candidates": [vc.to_dict() for vc in self.verified_candidates] if self.verified_candidates else None,
            "metadata": self.metadata,
            "duration_ms": self.duration_ms,
        }


@dataclass
class SubQuestionAnswer:
    """Answer for a single sub-question with evidence."""
    sub_question: SubQuestion
    answer: str | None
    evidence: list[VerifiedCandidate]
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "sub_question": self.sub_question.to_dict(),
            "answer": self.answer,
            "evidence": [e.to_dict() for e in self.evidence],
            "confidence": self.confidence,
        }


@dataclass
class RetrievalLimits:
    """Budget limits for retrieval and verification."""
    per_route_top_k: int = 20
    merge_top_n: int = 30
    verify_top_m: int = 15
    early_exit_threshold: int = 5  # High-confidence answers to trigger early exit


# =============================================================================
# Progressive Search Pipeline Types
# =============================================================================

class AnswerReadiness:
    """Answer readiness status for progressive search."""
    NO_ANSWER = "no_answer"
    PARTIAL_ANSWER = "partial_answer"
    GOOD_ANSWER = "good_answer"

    # Thresholds
    GOOD_THRESHOLD = 0.85
    PARTIAL_THRESHOLD = 0.65


@dataclass
class SearchMethod:
    """
    A single search method in the progressive pipeline.
    Methods are executed in order of cost_level (fast → slow).
    """
    name: str                       # e.g., "sparse", "dense"
    display_name: str               # User-friendly name, e.g., "Keyword Search", "Semantic Search"
    cost_level: int                 # 1=fastest, 6=slowest
    top_k: int                      # candidates to retrieve
    enabled: bool = True
    requires_user_opt_in: bool = False  # for expensive methods
    
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "cost_level": self.cost_level,
            "top_k": self.top_k,
            "enabled": self.enabled,
            "requires_user_opt_in": self.requires_user_opt_in,
        }


@dataclass
class MethodRunResult:
    """Result from running a single search method."""
    method_name: str
    candidates: list[Candidate]
    verified: list[VerifiedCandidate]
    status: str  # "no_answer" | "partial_answer" | "good_answer" | "skipped_need_opt_in"
    best_conf: float
    best_answer: str | None
    duration_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "method_name": self.method_name,
            "candidates": [c.to_dict() for c in self.candidates],
            "verified": [v.to_dict() for v in self.verified],
            "status": self.status,
            "best_conf": self.best_conf,
            "best_answer": self.best_answer,
            "duration_ms": self.duration_ms,
        }


@dataclass
class SubQueryProgressiveResult:
    """
    Result from progressive search of a single sub-query.
    Supports early exit with user decision points.
    """
    sub_query_id: str
    sub_query: str
    keywords: list[str]
    runs: list[MethodRunResult]
    global_pool_size: int
    best_so_far: str | None
    best_conf: float
    needs_user_decision: bool = False
    decision_options: list[str] = field(default_factory=list)  # ["use_current_results", "continue_search"]
    resume_token: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "sub_query_id": self.sub_query_id,
            "sub_query": self.sub_query,
            "keywords": self.keywords,
            "runs": [r.to_dict() for r in self.runs],
            "global_pool_size": self.global_pool_size,
            "best_so_far": self.best_so_far,
            "best_conf": self.best_conf,
            "needs_user_decision": self.needs_user_decision,
            "decision_options": self.decision_options,
            "resume_token": self.resume_token,
        }


# =============================================================================
# Existing Types
# =============================================================================

class EmbeddingUnavailableError(RuntimeError):
    """Raised when the embedding backend cannot be reached."""


@dataclass
class QueryRewriteResult:
    original: str
    effective: str
    alternates: list[str]
    applied: bool

    def variants(self, include_original: bool = True, limit: int = 4) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()

        def _push(value: str | None) -> None:
            if not value:
                return
            text = value.strip()
            if not text:
                return
            key = text.lower()
            if key in seen:
                return
            seen.add(key)
            ordered.append(text)

        _push(self.effective or self.original)
        for alternate in self.alternates:
            _push(alternate)
        if include_original:
            _push(self.original)
        if not ordered:
            ordered.append(self.original)
        return ordered[:limit]


class StepRecorder:
    def __init__(self, initial: Iterable[AgentStep] | None = None) -> None:
        self.steps: list[AgentStep] = list(initial) if initial else []

    def add(
        self,
        *,
        id: str,
        title: str,
        detail: str | None = None,
        status: str = "complete",
        queries: Iterable[str] | None = None,
        items: Iterable[str] | None = None,
        files: Iterable[AgentStepFile] | None = None,
        duration_ms: int | None = None,
    ) -> None:
        self.steps.append(
            AgentStep(
                id=id,
                title=title,
                detail=detail,
                status=status if status in {"running", "complete", "skipped", "error"} else "complete",
                queries=list(queries or []),
                items=list(items or []),
                files=list(files or []),
                duration_ms=duration_ms,
            )
        )

    def extend(self, steps: Iterable[AgentStep]) -> None:
        self.steps.extend(steps)

    def merge(self, other: AgentDiagnostics | None) -> None:
        if other and other.steps:
            self.steps.extend(other.steps)

    def snapshot(self, summary: str | None = None) -> AgentDiagnostics | None:
        if not self.steps and summary is None:
            return None
        return AgentDiagnostics(steps=list(self.steps), summary=summary)

class AuthenticationError(Exception):
    """Raised when authentication fails."""
    pass
