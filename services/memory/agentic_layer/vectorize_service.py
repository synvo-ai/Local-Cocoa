"""
Vectorize Service
Vectorization service using local llama.cpp embedding server

This module provides methods to get text embeddings using the local embedding service.
"""

from __future__ import annotations

import os
import asyncio
import logging
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import numpy as np

from services.llm.client import EmbeddingClient
from services.memory.memory_layer.constants import VECTORIZE_DIMENSIONS

logger = logging.getLogger(__name__)


@dataclass
class VectorizeConfig:
    """Vectorize configuration class"""
    
    timeout: int = 30
    max_retries: int = 3
    batch_size: int = 10
    max_concurrent_requests: int = 5
    dimensions: int = VECTORIZE_DIMENSIONS


class VectorizeError(Exception):
    """Vectorize API error exception class"""
    pass


@dataclass
class UsageInfo:
    """Token usage information"""
    prompt_tokens: int
    total_tokens: int


class VectorizeServiceInterface(ABC):
    """Vectorization service interface"""

    @abstractmethod
    async def get_embedding(
        self, text: str, instruction: Optional[str] = None
    ) -> np.ndarray:
        pass

    @abstractmethod
    async def get_embedding_with_usage(
        self, text: str, instruction: Optional[str] = None
    ) -> Tuple[np.ndarray, Optional[UsageInfo]]:
        pass

    @abstractmethod
    async def get_embeddings(
        self, texts: List[str], instruction: Optional[str] = None
    ) -> List[np.ndarray]:
        pass

    @abstractmethod
    async def get_embeddings_batch(
        self, text_batches: List[List[str]], instruction: Optional[str] = None
    ) -> List[List[np.ndarray]]:
        pass

    @abstractmethod
    def get_model_name(self) -> str:
        """Get the current model name"""
        pass


class VectorizeService(VectorizeServiceInterface):
    """
    Local vectorization service using llama.cpp embedding server
    """

    def __init__(self, config: Optional[VectorizeConfig] = None):
        if config is None:
            config = VectorizeConfig()
        
        self.config = config
        self.client = EmbeddingClient()
        self.client.timeout = float(config.timeout)
        self._semaphore = asyncio.Semaphore(config.max_concurrent_requests)
        
        logger.info(
            f"Initialized Local Vectorize Service | batch_size={config.batch_size} | dimensions={config.dimensions}"
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    async def _make_request(
        self,
        texts: List[str],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ) -> List[List[float]]:
        """Make embedding request to local server"""
        
        # Format texts with instruction if needed
        if is_query and instruction:
            formatted_texts = [
                f"Instruct: {instruction}\nQuery: {text}" for text in texts
            ]
        elif is_query:
            default_instruction = "Given a search query, retrieve relevant passages that answer the query"
            formatted_texts = [
                f"Instruct: {default_instruction}\nQuery: {text}" for text in texts
            ]
        else:
            formatted_texts = texts

        async with self._semaphore:
            for attempt in range(self.config.max_retries):
                try:
                    embeddings = await self.client.encode(formatted_texts)
                    return embeddings
                except Exception as e:
                    logger.error(f"Vectorize error (attempt {attempt + 1}): {e}")
                    if attempt < self.config.max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    else:
                        raise VectorizeError(f"Embedding request failed: {e}")

    def _truncate_embedding(self, embedding: List[float]) -> np.ndarray:
        """Truncate and normalize embedding to configured dimensions"""
        emb = np.array(embedding, dtype=np.float32)
        
        if self.config.dimensions and self.config.dimensions > 0 and len(emb) > self.config.dimensions:
            emb = emb[:self.config.dimensions]
            # Re-normalize after truncation
            norm = np.linalg.norm(emb)
            if norm > 0:
                emb = emb / norm
        
        return emb

    async def get_embedding(
        self, text: str, instruction: Optional[str] = None, is_query: bool = False
    ) -> np.ndarray:
        embeddings = await self._make_request([text], instruction, is_query)
        if not embeddings:
            raise VectorizeError("No embedding returned")
        return self._truncate_embedding(embeddings[0])

    async def get_embedding_with_usage(
        self, text: str, instruction: Optional[str] = None, is_query: bool = False
    ) -> Tuple[np.ndarray, Optional[UsageInfo]]:
        embedding = await self.get_embedding(text, instruction, is_query)
        # Local server doesn't return usage info
        return embedding, None

    async def get_embeddings(
        self,
        texts: List[str],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ) -> List[np.ndarray]:
        if not texts:
            return []

        if len(texts) <= self.config.batch_size:
            embeddings = await self._make_request(texts, instruction, is_query)
            return [self._truncate_embedding(e) for e in embeddings]

        all_embeddings = []
        for i in range(0, len(texts), self.config.batch_size):
            batch_texts = texts[i:i + self.config.batch_size]
            embeddings = await self._make_request(batch_texts, instruction, is_query)
            all_embeddings.extend([self._truncate_embedding(e) for e in embeddings])
            if i + self.config.batch_size < len(texts):
                await asyncio.sleep(0.1)
        
        return all_embeddings

    async def get_embeddings_batch(
        self,
        text_batches: List[List[str]],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ) -> List[List[np.ndarray]]:
        tasks = [
            self.get_embeddings(batch, instruction, is_query) for batch in text_batches
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        embeddings_batches = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"Error processing batch {i}: {result}")
                embeddings_batches.append([])
            else:
                embeddings_batches.append(result)
        return embeddings_batches

    def get_model_name(self) -> str:
        """Get the current model name"""
        return os.getenv("LOCAL_EMBEDDING_MODEL", "local-embedding")

    def get_model_info(self) -> Dict[str, Any]:
        return {
            "provider": "local",
            "model": self.get_model_name(),
            "timeout": self.config.timeout,
            "batch_size": self.config.batch_size,
            "max_concurrent": self.config.max_concurrent_requests,
            "dimensions": self.config.dimensions,
        }


_VECTORIZE_SERVICE: Optional[VectorizeServiceInterface] = None


def get_vectorize_service() -> VectorizeServiceInterface:
    global _VECTORIZE_SERVICE
    if _VECTORIZE_SERVICE is None:
        _VECTORIZE_SERVICE = VectorizeService()
    return _VECTORIZE_SERVICE


# Utility functions
async def get_text_embedding(
    text: str, instruction: Optional[str] = None, is_query: bool = False
) -> np.ndarray:
    return await get_vectorize_service().get_embedding(text, instruction, is_query)


async def get_text_embeddings(
    texts: List[str], instruction: Optional[str] = None, is_query: bool = False
) -> List[np.ndarray]:
    return await get_vectorize_service().get_embeddings(texts, instruction, is_query)


async def get_text_embeddings_batch(
    text_batches: List[List[str]],
    instruction: Optional[str] = None,
    is_query: bool = False,
) -> List[List[np.ndarray]]:
    return await get_vectorize_service().get_embeddings_batch(
        text_batches, instruction, is_query
    )


async def get_text_embedding_with_usage(
    text: str, instruction: Optional[str] = None, is_query: bool = False
) -> Tuple[np.ndarray, Optional[UsageInfo]]:
    return await get_vectorize_service().get_embedding_with_usage(
        text, instruction, is_query
    )
