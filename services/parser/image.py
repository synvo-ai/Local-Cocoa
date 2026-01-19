from __future__ import annotations

import io

from PIL import Image

from pathlib import Path

from .base import BaseParser, ParsedContent


class ImageParser(BaseParser):
    extensions = {"png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "heic", "svg"}

    def parse(self, path: Path) -> ParsedContent:
        with Image.open(path) as img:
            width, height = img.size
            preview = self._build_preview(img)
            metadata = {
                "source": "image",
                "width": width,
                "height": height,
                "mode": img.mode,
            }
        return ParsedContent(text="", metadata=metadata, preview_image=preview)

    def _build_preview(self, image: Image.Image) -> bytes:
        max_edge = 512
        img = image.copy()
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.thumbnail((max_edge, max_edge))
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=80)
        return buffer.getvalue()
