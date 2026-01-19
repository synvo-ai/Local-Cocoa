from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Optional

@dataclass
class ChunkPayload:
    chunk_id: str
    file_id: str
    ordinal: int
    text: str
    snippet: str
    token_count: int
    char_count: int
    section_path: Optional[str]
    metadata: dict
    created_at: dt.datetime


@dataclass
class SemanticBlock:
    """Represents a semantic unit (paragraph, list, code block, table, etc.)"""
    text: str
    block_type: str  # 'paragraph', 'list', 'code', 'table', 'heading'
    start_offset: int
    end_offset: int
