from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from services.core.config import settings
from services.parser import (
    AudioParser,
    BaseParser,
    DocParser,
    DocxParser,
    ImageParser,
    MarkdownParser,
    ParsedContent,
    PdfParser,
    PdfVisionParser,
    TextParser,
    VideoParser,
    GeneralParser,
    select_parser,
)


class ContentRouter:
    def __init__(self, parsers: Optional[Iterable[BaseParser]] = None) -> None:
        self.parsers = list(parsers) if parsers else self._default_parsers()
        # Keep references to specific parsers for dynamic switching
        self.pdf_text_parser = PdfParser()
        self.pdf_vision_parser = PdfVisionParser()

    def parse(self, path: Path, indexing_mode: str = "fast", **kwargs) -> ParsedContent:
        # Special handling for PDF to choose parser based on mode
        if path.suffix.lower() == ".pdf":
            # If Deep mode (fine) or configured for vision, use vision parser
            if indexing_mode == "fine" or indexing_mode == "deep" or settings.pdf_mode == "vision":
                try:
                    return self.pdf_vision_parser.parse(path, **kwargs)
                except TypeError:
                    return self.pdf_vision_parser.parse(path)

            # Fast mode: try text parser first

            try:
                content = self.pdf_text_parser.parse(path, **kwargs)
            except TypeError:
                content = self.pdf_text_parser.parse(path)

            # If text parser yielded no text (scanned PDF), and we are in fast mode,
            # we might want to fallback to vision parser for OCR if possible.
            # However, strictly speaking "fast" might imply "no heavy processing".
            # But if the result is empty, it's useless.
            # Let's fallback to vision parser (which enables OCR) if text is empty.
            if not content.text.strip():
                try:
                    return self.pdf_vision_parser.parse(path, **kwargs)
                except TypeError:
                    return self.pdf_vision_parser.parse(path)

            return content

        parser = select_parser(self.parsers, path)
        if not parser:
            # raise ValueError(f"Unsupported file type for {path}")
            parser = GeneralParser()

        try:
            return parser.parse(path, **kwargs)
        except TypeError:
            return parser.parse(path)

    @staticmethod
    def _default_parsers() -> list[BaseParser]:
        # Choose PDF parser based on configuration
        pdf_parser = PdfVisionParser() if settings.pdf_mode == "vision" else PdfParser()

        return [
            TextParser(),
            MarkdownParser(),
            pdf_parser,  # Dynamic selection based on settings
            DocParser(),
            DocxParser(),
            ImageParser(),
            VideoParser(),
            AudioParser(),
            GeneralParser(),
        ]


content_router = ContentRouter()
