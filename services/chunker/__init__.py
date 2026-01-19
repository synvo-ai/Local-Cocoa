from __future__ import annotations

import os
from .pipeline import ChunkingPipeline
from .types import ChunkPayload, SemanticBlock

DEFAULT_CHUNK_TOKENS = max(int(os.getenv("LOCAL_RAG_CHUNK_TOKENS", 320)), 64)
DEFAULT_CHUNK_OVERLAP = max(int(os.getenv("LOCAL_RAG_CHUNK_OVERLAP", 40)), 0)

chunking_pipeline = ChunkingPipeline(chunk_tokens=DEFAULT_CHUNK_TOKENS, overlap_tokens=DEFAULT_CHUNK_OVERLAP)

__all__ = ["ChunkingPipeline", "chunking_pipeline", "ChunkPayload", "SemanticBlock"]
