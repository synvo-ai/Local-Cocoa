"""
Rerank Service
Reranking service

This module provides methods to call DeepInfra or vLLM API for reranking retrieved memories.
This module provides methods to call DeepInfra or vLLM API to rerank retrieved memories.
"""

from __future__ import annotations

import os
import asyncio
import aiohttp
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import List, Dict, Any, Optional, Union
from dataclasses import dataclass, field
import numpy as np

try:
    import cohere
except ImportError:
    cohere = None

from services.memory.api_specs.memory_models import MemoryType

logger = logging.getLogger(__name__)


class RerankProvider(str, Enum):
    """Rerank service provider enumeration"""

    DEEPINFRA = "deepinfra"
    VLLM = "vllm"
    COHERE = "cohere"


@dataclass
class RerankConfig:
    """Rerank API configuration class"""

    provider: RerankProvider = RerankProvider.DEEPINFRA
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    timeout: int = 30
    max_retries: int = 3
    batch_size: int = 10
    max_concurrent_requests: int = 5

    def __post_init__(self):
        """Initialize after loading configuration values from environment variables"""
        # Handle provider
        env_provider = os.getenv("RERANK_PROVIDER")
        if env_provider:
            provider_str = env_provider.lower()
            try:
                self.provider = RerankProvider(provider_str)
            except ValueError:
                logger.error(
                    f"Invalid rerank provider '{provider_str}', expected one of {[p.value for p in RerankProvider]}"
                )
                raise ValueError(
                    f"Invalid rerank provider '{provider_str}', expected one of {[p.value for p in RerankProvider]}"
                )

        if not self.api_key:
            self.api_key = os.getenv("RERANK_API_KEY", "")
            if self.provider == RerankProvider.COHERE and not self.api_key:
                self.api_key = os.getenv("COHERE_API_KEY", "")
            if self.provider == RerankProvider.VLLM and not self.api_key:
                self.api_key = "EMPTY"

        if not self.base_url:
            # vLLM/Local default might be http://localhost:12000/score
            default_url = (
                "https://api.deepinfra.com/v1/inference"
                if self.provider == RerankProvider.DEEPINFRA
                else "http://localhost:12000/score"
            )
            if self.provider == RerankProvider.COHERE:
                default_url = ""
            self.base_url = os.getenv("RERANK_BASE_URL", default_url)

        if not self.model:
            if self.provider == RerankProvider.COHERE:
                self.model = os.getenv("RERANK_MODEL", "rerank-v3.5")
            else:
                self.model = os.getenv("RERANK_MODEL", "Qwen/Qwen3-Reranker-4B")

        if self.timeout == 30:
            self.timeout = int(os.getenv("RERANK_TIMEOUT", "30"))
        if self.max_retries == 3:
            self.max_retries = int(os.getenv("RERANK_MAX_RETRIES", "3"))
        if self.batch_size == 10:
            self.batch_size = int(os.getenv("RERANK_BATCH_SIZE", "10"))
        if self.max_concurrent_requests == 5:
            self.max_concurrent_requests = int(os.getenv("RERANK_MAX_CONCURRENT", "5"))


class RerankError(Exception):
    """Rerank API error exception class"""

    pass


@dataclass
class RerankMemResponse:
    """Reranked memory retrieval response"""

    memories: List[Dict[str, List[Any]]] = field(default_factory=list)
    scores: List[Dict[str, List[float]]] = field(default_factory=list)
    rerank_scores: List[Dict[str, List[float]]] = field(default_factory=list)
    importance_scores: List[float] = field(default_factory=list)
    original_data: List[Dict[str, List[Dict[str, Any]]]] = field(default_factory=list)
    total_count: int = 0
    has_more: bool = False
    query_metadata: Any = field(default_factory=dict)
    metadata: Any = field(default_factory=dict)


class RerankServiceInterface(ABC):
    """Reranking service interface"""

    @abstractmethod
    async def rerank_memories(
        self, query: str, retrieve_response: Any, instruction: str = None
    ) -> Union[RerankMemResponse, List[Dict[str, Any]]]:
        pass


class RerankService(RerankServiceInterface):
    """
    Reranking service class (supports DeepInfra, vLLM)
    """

    def __init__(self, config: Optional[RerankConfig] = None):
        if config is None:
            config = self._load_config_from_env()

        self.config = config
        self.session: Optional[aiohttp.ClientSession] = None
        self._semaphore = asyncio.Semaphore(config.max_concurrent_requests)
        logger.info(
            f"Initialized Rerank Service | provider={config.provider.value} | model={config.model}"
        )

    def _load_config_from_env(self) -> RerankConfig:
        return RerankConfig()

    async def __aenter__(self):
        await self._ensure_session()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    def _is_session_closed(self) -> bool:
        if self.session is None:
            return True
        closed_attr = getattr(self.session, "closed", None)
        if isinstance(closed_attr, bool):
            return closed_attr
        return False

    async def _ensure_session(self):
        if self._is_session_closed():
            if self.config.provider == RerankProvider.COHERE:
                if cohere is None:
                    raise RerankError("cohere package not installed")
                self.session = cohere.AsyncClientV2(
                    api_key=self.config.api_key,
                    timeout=self.config.timeout,
                )
            else:
                timeout = aiohttp.ClientTimeout(total=self.config.timeout)
                self.session = aiohttp.ClientSession(
                    timeout=timeout,
                    headers={
                        "Authorization": f"Bearer {self.config.api_key}",
                        "Content-Type": "application/json",
                    },
                )

    async def close(self):
        if not self.session:
            return
        close_method = getattr(self.session, "close", None)
        if callable(close_method):
            result = close_method()
            if asyncio.iscoroutine(result):
                await result
        self.session = None

    async def _make_rerank_request(
        self, query: str, documents: List[str], instruction: str = None
    ) -> Dict[str, Any]:
        if not documents:
            return {"results": []}

        # Split into batches
        batch_size = self.config.batch_size
        if batch_size <= 0:
            batch_size = 10

        batches = [
            documents[i : i + batch_size] for i in range(0, len(documents), batch_size)
        ]

        batch_tasks = []
        for i, batch in enumerate(batches):
            start_index = i * batch_size
            batch_tasks.append(
                self._send_rerank_request_batch(query, batch, start_index, instruction)
            )

        batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)

        all_scores = []
        total_input_tokens = 0
        last_response = None

        for i, result in enumerate(batch_results):
            if isinstance(result, Exception):
                logger.error(f"Rerank batch {i} failed: {result}")
                batch_len = len(batches[i])
                all_scores.extend([-100.0] * batch_len)
                continue

            scores = result.get("scores", [])
            all_scores.extend(scores)
            total_input_tokens += result.get("input_tokens", 0)
            last_response = result

        if not last_response and not all_scores:
            pass

        combined_response = {
            "scores": all_scores,
            "input_tokens": total_input_tokens,
            "request_id": last_response.get("request_id") if last_response else None,
        }
        return self._convert_response_format(combined_response, len(documents))

    def _format_rerank_texts(
        self, query: str, documents: List[str], instruction: Optional[str] = None
    ):
        """Build Rerank request text (Qwen-Reranker general format)"""
        prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
        suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        instruction = (
            instruction
            or "Given a question and a passage, determine if the passage contains information relevant to answering the question."
        )

        formatted_query = f"{prefix}<Instruct>: {instruction}\n<Query>: {query}\n"
        formatted_docs = [f"<Document>: {doc}{suffix}" for doc in documents]

        return [formatted_query] * len(documents), formatted_docs

    async def _send_rerank_request_batch(
        self,
        query: str,
        documents: List[str],
        start_index: int,
        instruction: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send request based on provider"""
        await self._ensure_session()

        if self.config.provider == RerankProvider.COHERE:
            try:
                response = await self.session.rerank(
                    model=self.config.model,
                    query=query,
                    documents=documents,
                    top_n=len(documents),
                )
                return self._parse_provider_response(response)
            except Exception as e:
                logger.error(f"Rerank Exception (cohere): {e}")
                raise RerankError(f"Exception: {e}")

        # Uniformly format text (Qwen-Reranker model format)
        queries, formatted_docs = self._format_rerank_texts(
            query, documents, instruction
        )

        url = self.config.base_url

        if self.config.provider == RerankProvider.DEEPINFRA:
            if not url.endswith(self.config.model):
                url = f"{url}/{self.config.model}"
            request_data = {"queries": queries, "documents": formatted_docs}
        else:
            # vLLM
            request_data = {
                "model": self.config.model,
                "text_1": queries,
                "text_2": formatted_docs,
            }

        async with self._semaphore:
            for attempt in range(self.config.max_retries):
                try:
                    async with self.session.post(url, json=request_data) as response:
                        if response.status == 200:
                            json_body = await response.json()
                            return self._parse_provider_response(json_body)
                        else:
                            error_text = await response.text()
                            logger.error(
                                f"Rerank API error ({self.config.provider.value}) {response.status}: {error_text}"
                            )
                            if attempt < self.config.max_retries - 1:
                                await asyncio.sleep(2**attempt)
                                continue
                            raise RerankError(
                                f"API failed: {response.status} - {error_text}"
                            )
                except Exception as e:
                    logger.error(
                        f"Rerank Exception ({self.config.provider.value}): {e}"
                    )
                    if attempt < self.config.max_retries - 1:
                        await asyncio.sleep(2**attempt)
                        continue
                    raise RerankError(f"Exception: {e}")

    def _parse_provider_response(self, json_body: Dict[str, Any]) -> Dict[str, Any]:
        """Parse responses from different providers into a unified format: {scores: [], input_tokens: int, ...}"""
        scores = []
        if self.config.provider == RerankProvider.COHERE:
            results = getattr(json_body, "results", None) or []
            results = list(results)
            results.sort(key=lambda x: getattr(x, "index", 0))
            scores = [getattr(item, "relevance_score", 0.0) for item in results]
            return {
                "scores": scores,
                "input_tokens": 0,
                "request_id": None,
            }
        if self.config.provider == RerankProvider.DEEPINFRA:
            if "results" in json_body:
                results = json_body["results"]
                results.sort(key=lambda x: x.get("index", 0))
                scores = [item.get("relevance_score", 0.0) for item in results]
            elif "scores" in json_body:
                scores = json_body["scores"]
        else:
            if "data" in json_body:
                scores = [item.get("score", 0.0) for item in json_body["data"]]
            elif "scores" in json_body:
                scores = json_body["scores"]

        return {
            "scores": scores,
            "input_tokens": json_body.get("usage", {}).get("prompt_tokens", 0)
            or json_body.get("input_tokens", 0),
            "request_id": json_body.get("id") or json_body.get("request_id"),
        }

    def _convert_response_format(
        self, combined_response: Dict[str, Any], num_documents: int
    ) -> Dict[str, Any]:
        scores = combined_response.get("scores", [])
        if len(scores) < num_documents:
            scores.extend([0.0] * (num_documents - len(scores)))
        scores = scores[:num_documents]

        indexed_scores = [(i, score) for i, score in enumerate(scores)]
        indexed_scores.sort(key=lambda x: x[1], reverse=True)

        results = []
        for rank, (original_index, score) in enumerate(indexed_scores):
            results.append(
                {"index": original_index, "score": score, "rank": rank}
            )

        return {
            "results": results,
            "input_tokens": combined_response.get("input_tokens", 0),
            "request_id": combined_response.get("request_id"),
        }

    def _extract_memory_text(self, memory: Any) -> str:
        if hasattr(memory, 'episode') and memory.episode:
            return memory.episode
        elif hasattr(memory, 'summary') and memory.summary:
            return memory.summary
        elif hasattr(memory, 'subject') and memory.subject:
            return memory.subject
        return str(memory)

    def _extract_text_from_hit(self, hit: Dict[str, Any]) -> str:
        """Extract and concatenate text based on memory_type"""
        source = hit.get('_source', hit)
        memory_type = hit.get('memory_type', '')
        
        # Debug: log first hit's structure
        if not hasattr(self, '_debug_logged'):
            self._debug_logged = True
            logger.info(f"[DEBUG] _extract_text_from_hit: memory_type={memory_type!r}, hit_keys={list(hit.keys())[:10]}, source_keys={list(source.keys())[:10]}")
        
        # Extract text based on memory_type
        match memory_type:
            case MemoryType.EPISODIC_MEMORY.value:
                episode = source.get('episode', '')
                if episode:
                    return f"Episode Memory: {episode}"
            case MemoryType.FORESIGHT.value:
                foresight = source.get('foresight', '') or source.get('content', '')
                evidence = source.get('evidence', '')
                if foresight:
                    if evidence:
                        return f"Foresight: {foresight} (Evidence: {evidence})"
                    return f"Foresight: {foresight}"
            case MemoryType.EVENT_LOG.value:
                atomic_fact = source.get('atomic_fact', '')
                if atomic_fact:
                    return f"Atomic Fact: {atomic_fact}"
        
        # Generic fallback - also log when we hit this
        logger.debug(f"[DEBUG] Fallback extraction: memory_type={memory_type!r}")
        if source.get('episode'): return source['episode']
        if source.get('atomic_fact'): return source['atomic_fact']
        if source.get('foresight'): return source['foresight']
        if source.get('content'): return source['content']
        if source.get('summary'): return source['summary']
        if source.get('subject'): return source['subject']
        return str(hit)

    async def rerank_memories(
        self, query: str, retrieve_response: Any, instruction: str = None
    ) -> Union[RerankMemResponse, List[Dict[str, Any]]]:

        # 1. Handle List of hits (raw dicts) - delegate to _rerank_all_hits
        if isinstance(retrieve_response, list):
            return await self._rerank_all_hits(query, retrieve_response, instruction=instruction)

        # 2. Handle RetrieveMemResponse object
        if not hasattr(retrieve_response, 'memories') or not retrieve_response.memories:
            return RerankMemResponse(memories=[], scores=[])

        all_memories_meta = []
        all_texts = []

        for group_idx, memory_dict_by_group in enumerate(retrieve_response.memories):
            for group_id, memory_list in memory_dict_by_group.items():
                for mem_idx, memory in enumerate(memory_list):
                    all_memories_meta.append((group_idx, group_id, mem_idx, memory))
                    all_texts.append(self._extract_memory_text(memory))

        if not all_texts:
            return RerankMemResponse(
                memories=retrieve_response.memories,
                scores=retrieve_response.scores,
                total_count=getattr(retrieve_response, 'total_count', 0),
            )

        try:
            rerank_result = await self._make_rerank_request(
                query, all_texts, instruction
            )
            results_meta = rerank_result.get("results", [])

            group_data_map = {}

            for item in results_meta:
                original_idx = item["index"]
                score = item["score"]

                group_idx, group_id, mem_idx, memory = all_memories_meta[original_idx]

                if group_id not in group_data_map:
                    group_data_map[group_id] = {
                        "memories": [],
                        "scores": [],
                        "rerank_scores": [],
                        "original_data": [],
                    }

                orig_score = 0.0
                if group_idx < len(retrieve_response.scores):
                    g_scores = retrieve_response.scores[group_idx].get(group_id, [])
                    if mem_idx < len(g_scores):
                        orig_score = g_scores[mem_idx]

                orig_data = {}
                if hasattr(retrieve_response, 'original_data') and group_idx < len(
                    retrieve_response.original_data
                ):
                    g_data = retrieve_response.original_data[group_idx].get(
                        group_id, []
                    )
                    if mem_idx < len(g_data):
                        orig_data = g_data[mem_idx]

                group_data_map[group_id]["memories"].append(memory)
                group_data_map[group_id]["scores"].append(orig_score)
                group_data_map[group_id]["rerank_scores"].append(score)
                group_data_map[group_id]["original_data"].append(orig_data)

            final_memories = [{gid: d["memories"] for gid, d in group_data_map.items()}]
            final_scores = [{gid: d["scores"] for gid, d in group_data_map.items()}]
            final_rerank_scores = [
                {gid: d["rerank_scores"] for gid, d in group_data_map.items()}
            ]
            final_original_data = [
                {gid: d["original_data"] for gid, d in group_data_map.items()}
            ]

            return RerankMemResponse(
                memories=final_memories,
                scores=final_scores,
                rerank_scores=final_rerank_scores,
                original_data=final_original_data,
                total_count=len(all_texts),
                has_more=getattr(retrieve_response, 'has_more', False),
                metadata=getattr(retrieve_response, 'metadata', {}),
            )

        except Exception as e:
            logger.error(f"Rerank object failed: {e}")
            return RerankMemResponse(
                memories=retrieve_response.memories,
                scores=retrieve_response.scores,
                total_count=getattr(retrieve_response, 'total_count', 0),
            )

    async def _rerank_all_hits(
        self,
        query: str,
        all_hits: List[Dict[str, Any]],
        top_k: int = None,
        instruction: str = None,
    ) -> List[Dict[str, Any]]:
        """Rerank the all_hits list and return top_k results

        Args:
            query: Query text
            all_hits: Search result list, each element is Dict[str, Any]
            top_k: Maximum number of results to return, if None return all results
            instruction: Optional reranking instruction

        Returns:
            Reranked hit list, each hit contains unified score field
        """
        if not all_hits:
            return []

        # Extract text content from all_hits for reranking
        all_texts = []
        for hit in all_hits:
            text = self._extract_text_from_hit(hit)
            all_texts.append(text)

        if not all_texts:
            return []

        # Call reranking API
        try:
            logger.debug(
                f"Starting reranking, query text: {query}, number of texts: {len(all_texts)}"
            )
            rerank_result = await self._make_rerank_request(
                query, all_texts, instruction
            )

            if "results" not in rerank_result:
                raise RerankError("Invalid rerank API response: missing results field")

            # Parse reranking results
            results_meta = rerank_result.get("results", [])

            # Reorganize hits according to reranked order
            reranked_hits = []
            for item in results_meta:
                original_idx = item.get("index", 0)
                score = item.get("score", 0.0)
                if 0 <= original_idx < len(all_hits):
                    hit = all_hits[original_idx].copy()
                    hit['score'] = score  # Unified score field
                    reranked_hits.append(hit)

            # If top_k is specified, return only the top_k results
            if top_k is not None and top_k > 0:
                reranked_hits = reranked_hits[:top_k]

            # Print top 3 result scores for debugging
            if reranked_hits:
                top_scores = [f"{h.get('score', 0):.4f}" for h in reranked_hits[:3]]
                logger.info(f"Reranking completed: {len(reranked_hits)} results, top scores: {top_scores}")
            return reranked_hits

        except Exception as e:
            logger.error(f"Error during reranking all_hits: {e}")
            # If reranking fails, return original results (sorted by original score)
            sorted_hits = sorted(
                all_hits, key=lambda x: x.get('score', 0), reverse=True
            )
            if top_k is not None and top_k > 0:
                sorted_hits = sorted_hits[:top_k]
            return sorted_hits



_RERANK_SERVICE: Optional[RerankServiceInterface] = None


def get_rerank_service() -> RerankServiceInterface:
    global _RERANK_SERVICE
    if _RERANK_SERVICE is None:
        _RERANK_SERVICE = RerankService()
    return _RERANK_SERVICE
