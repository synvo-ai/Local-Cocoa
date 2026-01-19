from __future__ import annotations

from pathlib import Path

from markdown_it import MarkdownIt

from .base import BaseParser, ParsedContent

_md = MarkdownIt()


class MarkdownParser(BaseParser):
    extensions = {"md", "markdown", "mdx"}

    def parse(self, path: Path) -> ParsedContent:
        raw = path.read_text(encoding="utf-8", errors="ignore")
        text = _md.render(raw)
        truncated = self._truncate(text)
        return ParsedContent(text=truncated, metadata={"source": "markdown"})
