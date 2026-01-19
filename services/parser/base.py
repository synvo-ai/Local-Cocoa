from __future__ import annotations

import abc
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from markitdown import MarkItDown


@dataclass
class ParsedContent:
    text: str
    metadata: dict
    preview_image: Optional[bytes] = None
    duration_seconds: Optional[float] = None
    page_count: Optional[int] = None
    attachments: dict = field(default_factory=dict)
    # Maps character offset ranges to page numbers: [(start_offset, end_offset, page_num), ...]
    page_mapping: list[tuple[int, int, int]] = field(default_factory=list)


class BaseParser(abc.ABC):
    extensions: set[str] = set()

    def __init__(self, *, max_chars: int = 4000) -> None:
        self.max_chars = max_chars
        self.md = MarkItDown()

    @abc.abstractmethod
    def parse(self, path: Path) -> ParsedContent:
        raise NotImplementedError

    def _truncate(self, text: str) -> str:
        if self.max_chars and len(text) > self.max_chars:
            return text[: self.max_chars]
        return text

    @classmethod
    def can_handle(cls, path: Path) -> bool:
        return path.suffix.lower().lstrip(".") in cls.extensions


def select_parser(parsers: Iterable[BaseParser], path: Path) -> Optional[BaseParser]:
    for parser in parsers:
        if parser.can_handle(path):
            return parser
    return None
