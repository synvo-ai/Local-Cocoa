from __future__ import annotations

import logging
import io
import tempfile
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    fitz = None

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:  # pragma: no cover
    np = None
    HAS_NUMPY = False

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

from .base import BaseParser, ParsedContent
from .pdf import PdfParser
from .vision_router import VisionRouter
from .img_2_wordbox import IMG2WORDS
from ..vlm.service import VisionProcessor
from services.core.context import get_llm_client

import asyncio


logger = logging.getLogger(__name__)

class PdfDeepParser(PdfParser):
    def __init__(self,threshold = 0.85):
        self._text_parser = PdfParser()
        self._image_tempdir: tempfile.TemporaryDirectory[str] | None = None
        self.ocr_workder = IMG2WORDS()
        self.vision_router = VisionRouter()
        vlm_client = get_llm_client()
        self.vlm = VisionProcessor(vlm_client)
        self.threshold = threshold

    def turn_pdf_into_images(
        self,
        path: Path,
        *,
        as_array: bool = True,
        output_dir: Path | None = None,
        zoom: float = 1.0,
    ) -> dict:
        """Render PDF pages into images.

        Returns a dict of {page_number: <np.ndarray|path>}.
        """
        if not fitz:
            raise ImportError("PyMuPDF (fitz) is not installed.")
        if as_array and not HAS_NUMPY:
            raise ImportError("numpy is required for array output.")

        self._cleanup_image_tempdir()
        if not as_array and output_dir is None:
            self._image_tempdir = tempfile.TemporaryDirectory(prefix="pdf_pages_")
            output_dir = Path(self._image_tempdir.name)
            output_dir.mkdir(parents=True, exist_ok=True)
        elif output_dir is not None:
            output_dir.mkdir(parents=True, exist_ok=True)

        results:dict = {}
        doc = fitz.open(str(path))
        try:
            matrix = fitz.Matrix(zoom, zoom)
            
            for page_index, page in enumerate(doc, start=1):
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                if as_array:
                    data = np.frombuffer(pix.samples, dtype=np.uint8)
                    channels = pix.n
                    image = data.reshape((pix.height, pix.width, channels))
                    results[page_index] = image
                else:
                    assert output_dir is not None
                    image_path = output_dir / f"page_{page_index}.png"
                    pix.save(str(image_path))
                    results[page_index] = str(image_path)
        finally:
            doc.close()

        return results

    def _cleanup_image_tempdir(self) -> None:
        if self._image_tempdir is not None:
            self._image_tempdir.cleanup()
            self._image_tempdir = None

    def _array_to_bytes(self, image_array) -> bytes:
        """Convert a numpy image array to PNG bytes."""
        if Image is None:
            raise ImportError("Pillow is required to encode image arrays.")
        if not HAS_NUMPY:
            raise ImportError("numpy is required to encode image arrays.")
        if image_array.dtype != np.uint8:
            image_array = image_array.astype(np.uint8)
        if image_array.ndim == 2:
            mode = "L"
        else:
            mode = "RGB"
            if image_array.shape[2] == 4:
                mode = "RGBA"
        with Image.fromarray(image_array, mode=mode) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            return buffer.getvalue()
    
    def parse(self, path: Path) -> ParsedContent:
        """
        Parse PDF by converting each page to an image.

        Returns ParsedContent with:
        - text: Empty or placeholder (VLM will generate the actual text)
        - attachments: Dict of page images {f"page_{num}": bytes}
        - page_count: Number of pages
        - page_mapping: Empty list (will be populated per-page after VLM processing)
        """
        try:
            # Use centralized vision processor to render images
            # Returns dict { "page_1": bytes, ... }
            attachments = self.turn_pdf_into_images(path)
        except Exception as e:
            raise ImportError(
                f"Failed to convert PDF to images: {e}. "
                "Ensure 'pymupdf' is installed (pip install pymupdf)."
            )
        page_count = len(attachments)

        # Use PdfParser's enhanced text extraction (with column detection)
        # This provides better quality text for fallback and hybrid mode
        page_texts = []
        page_mapping=[] 
        if fitz:
            try:
                doc = fitz.open(str(path))
                if doc.is_encrypted:
                    doc.authenticate("")
                for index,page in enumerate(doc,start=1):
                    cursor = 0
                    # # Use enhanced extraction with column detection
                    # page_text = self._text_parser._extract_text_enhanced(page)
                    # if not page_text:
                    page_text = ""
                    page_img = attachments[index]
                    page_bboxs = self.ocr_workder.run(page_img)
                    page_text = self._text_parser._extract_text_from_bboxes(page_img,page_bboxs)
                    page_bboxs_pure = [data[:4] for data in page_bboxs]
                    need_vlm = self.vision_router.run(page_img,page_bboxs_pure)
                    if need_vlm["bbox_ratio_effective"] <= self.threshold:
                        page_bytes = self._array_to_bytes(page_img)
                        caption = asyncio.run(self.vlm.process_image(page_bytes))
                        page_text = f"{page_text} caption:({caption})"
                    
                    start = cursor
                    end = start + len(page_text)
                    cursor = end
                    if index < page_count:
                        cursor += 2  # "\n\n"

                    page_texts.append(page_text)
                    page_mapping.append((start, end,index))

                doc.close()
            except Exception:
                pass



        page_text_final = "".join([f"--PAGE_{index}--\n{page_texts}" for index in enumerate(page_texts,start=1)])

        metadata = {
            "source": "pdf_vision",
            "pages": page_count,
            "processing_mode": "vision",
            "page_texts": page_texts,
        }

        return ParsedContent(
            text=page_text_final,
            metadata=metadata,
            page_count=page_count,
            attachments=attachments,
            page_mapping=page_mapping,
        )
