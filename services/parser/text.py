from __future__ import annotations

from pathlib import Path

from .base import BaseParser, ParsedContent


class TextParser(BaseParser):
    extensions = {"txt", "log", "cfg", "ini", "json", "yaml", "yml"}

    def parse(self, path: Path) -> ParsedContent:
        text = path.read_text(encoding="utf-8", errors="ignore")
        truncated = self._truncate(text)
        return ParsedContent(text=truncated, metadata={"source": "text"})
