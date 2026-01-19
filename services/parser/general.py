from __future__ import annotations

from pathlib import Path

from .base import BaseParser, ParsedContent


class GeneralParser(BaseParser):
    def parse(self, path: Path, postfix: str) -> ParsedContent:
        text = "unable to parse the file" + str(path)
        truncated = self._truncate(text)
        metadata = {"source": postfix}
        try:
            result = self.md.convert(str(path))
            text = result.text_content
            truncated = self._truncate(text)

            return ParsedContent(text=truncated, metadata=metadata)

        except Exception:
            return ParsedContent(text=truncated, metadata=metadata)
