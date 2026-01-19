"""
Centralized vision processing service for OCR, VLM, and image manipulation.
"""
from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path
from typing import Literal

from PIL import Image
import numpy as np

try:
    from rapidocr import RapidOCR
except ImportError:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        RapidOCR = None

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

from services.llm.client import LlmClient
from services.core.config import settings
from services.core.i18n import get_prompt, DEFAULT_LANGUAGE, SupportedLanguage

logger = logging.getLogger(__name__)


def render_pdf_images(path: Path) -> dict[str, bytes]:
    """
    Convert PDF pages to images using PyMuPDF (fitz).
    Returns dict { "page_1": bytes, "page_2": bytes, ... }
    """
    if not fitz:
        raise ImportError("PyMuPDF (fitz) is not installed. Cannot process PDF images.")

    images = {}
    max_pixels = settings.vision_max_pixels

    try:
        doc = fitz.open(str(path))
        for i in range(len(doc)):
            page = doc.load_page(i)

            # Default 2x zoom for better OCR/VLM quality
            zoom = 2.0

            # Adjust zoom if it exceeds max pixels
            if max_pixels > 0:
                rect = page.rect
                # Check projected size at 2x
                if (rect.width * zoom) * (rect.height * zoom) > max_pixels:
                    zoom = (max_pixels / (rect.width * rect.height)) ** 0.5

            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img_data = pix.tobytes("png")
            images[f"page_{i+1}"] = img_data
        doc.close()
        return images
    except Exception as e:
        logger.error(f"Failed to render PDF {path}: {e}")
        raise


class VisionProcessor:
    """
    Handles all visual processing tasks:
    1. PDF to Image conversion (rendering).
    2. OCR (RapidOCR) for "fast" mode.
    3. VLM (Vision Language Model) description for "deep" mode.
    4. Image resizing/preprocessing.
    """

    def __init__(self, llm_client: LlmClient):
        self.llm_client = llm_client
        self.last_error: str | None = None
        self._ocr_engine = None
        if RapidOCR:
            # Initialize RapidOCR with default options
            # User mentioned PP-OCRv5 support in rapidocr>=3.0.0
            # We can pass parameters if needed, but defaults are usually fine for general use
            try:
                self._ocr_engine = RapidOCR()
            except Exception as e:
                logger.error(f"Failed to initialize RapidOCR: {e}")

    def render_pdf_images(self, path: Path) -> dict[str, bytes]:
        """
        Convert PDF pages to images using PyMuPDF (fitz).
        Returns dict { "page_1": bytes, "page_2": bytes, ... }
        Synchronous version for use in Parsers.
        """
        return render_pdf_images(path)

    async def pdf_to_images(self, path: Path) -> dict[str, bytes]:
        """
        Convert PDF pages to images using PyMuPDF (fitz).
        Returns dict { "page_1": bytes, "page_2": bytes, ... }
        """
        return await asyncio.to_thread(render_pdf_images, path)

    async def process_image(
        self,
        image_bytes: bytes,
        mode: Literal["fast", "deep"] = "deep",
        prompt: str = "Describe this image.",
        max_tokens: int | None = None,
        language: SupportedLanguage = DEFAULT_LANGUAGE
    ) -> str:
        """
        Process an image to extract text/description.

        Args:
            image_bytes: Raw image data.
            mode: 'fast' (OCR) or 'deep' (VLM).
            prompt: Prompt for VLM (ignored in fast mode). If not provided, uses i18n prompt.
            max_tokens: Max output tokens for VLM (ignored in fast mode).
                        If None, uses settings.pdf_page_max_tokens (default 2048).
            language: Language for prompts (default: en).
        """
        if mode == "fast":
            return await self._ocr_image(image_bytes)
        else:
            # Use multilingual prompt if default prompt is used
            if prompt == "Describe this image.":
                prompt = get_prompt("image", language)
            return await self._describe_image(image_bytes, prompt, max_tokens)

    async def _ocr_image(self, image_bytes: bytes) -> str:
        """Run RapidOCR on image bytes."""
        if not self._ocr_engine:
            logger.warning("RapidOCR engine not initialized.")
            return ""

        def _run():
            try:
                with Image.open(io.BytesIO(image_bytes)) as img:
                    # Convert to RGB if needed
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    # Convert to numpy array for RapidOCR
                    img_np = np.array(img)

                # Run OCR
                # RapidOCR returns a tuple (result, elapse) or similar structure depending on version
                # result is a list of [box, text, score]
                result, _ = self._ocr_engine(img_np)

                if not result:
                    return ""

                # Try to use to_markdown if available (as requested by user)
                # Note: The standard rapidocr_onnxruntime returns a list, not an object with methods.
                # The user might be referring to a specific wrapper or version.
                # We will construct markdown manually if the method doesn't exist.

                if hasattr(result, "to_markdown"):
                    return result.to_markdown()

                # Manual markdown construction (simple)
                # Just joining text for now, as layout analysis is complex without the specific method
                texts = [line[1] for line in result]
                return "\n".join(texts)

            except Exception as e:
                logger.warning(f"OCR failed: {e}")
                return ""

        return await asyncio.to_thread(_run)

    async def _describe_image(self, image_bytes: bytes, prompt: str, max_tokens: int | None = None) -> str:
        """Run VLM description on image bytes.

        Args:
            image_bytes: Raw image data.
            prompt: Prompt for the VLM.
            max_tokens: Maximum output tokens. If None, uses settings.pdf_page_max_tokens.
        """
        if not settings.endpoints.vision:
            logger.warning("Vision endpoint not configured.")
            self.last_error = "Vision endpoint not configured"
            return ""

        try:
            # Use provided max_tokens or fall back to the pdf_page_max_tokens setting.
            # This allows callers to override for specific use cases (e.g., simple images vs complex PDFs).
            max_output_tokens = max_tokens if max_tokens is not None else settings.pdf_page_max_tokens
            description = await self.llm_client.describe_frames(
                [image_bytes],
                prompt=prompt,
                max_tokens=max_output_tokens,
            )
            self.last_error = None
            return description or ""
        except Exception as e:
            msg = str(e) or repr(e)
            self.last_error = msg
            logger.warning("VLM description failed: %s", msg)
            return ""
