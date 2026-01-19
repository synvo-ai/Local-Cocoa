from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
import shutil

from .pdf import PdfParser
from .base import ParsedContent


class DocVisionParser(PdfParser):
    """Parse doc/docx by converting to PDF and reusing PdfParser."""

    extensions = {"doc", "docx"}

    def __init__(self) -> None:
        super().__init__()
        self.pdf_path: Path | None = None
        self._tempdir: tempfile.TemporaryDirectory[str] | None = None

    def parse(self, path: Path) -> ParsedContent:
        self._cleanup_tempdir()
        pdf_path = self._convert_to_pdf(path)
        self.pdf_path = pdf_path
        parsed = super().parse(pdf_path)
        parsed.metadata = parsed.metadata or {}
        parsed.metadata["source"] = "doc_vision"
        parsed.metadata["original_path"] = str(path)
        parsed.metadata["converted_pdf"] = str(pdf_path)
        return parsed

    def _convert_to_pdf(self, path: Path) -> Path:
        soffice = shutil.which("soffice")
        if not soffice:
            raise FileNotFoundError("LibreOffice 'soffice' is required to convert doc/docx to PDF.")

        self._tempdir = tempfile.TemporaryDirectory(prefix="doc_vision_")
        tmp_dir = Path(self._tempdir.name)
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(tmp_dir), str(path)],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        pdf_path = tmp_dir / f"{path.stem}.pdf"
        if not pdf_path.exists():
            raise FileNotFoundError(f"Failed to convert {path} to PDF.")
        return pdf_path

    def _cleanup_tempdir(self) -> None:
        if self._tempdir is not None:
            self._tempdir.cleanup()
            self._tempdir = None

    def close(self) -> None:
        self._cleanup_tempdir()

    def __del__(self) -> None:
        self._cleanup_tempdir()
