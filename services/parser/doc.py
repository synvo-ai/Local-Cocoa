from __future__ import annotations

import importlib
import importlib.util
import subprocess
import tempfile
from pathlib import Path
from typing import Optional
import shutil

from .base import BaseParser, ParsedContent


class DocParser(BaseParser):
    extensions = {"doc"}

    def parse(self, path: Path) -> ParsedContent:
        text = self._extract_text(path)
        truncated = self._truncate(text)
        metadata = {"source": "doc"}
        return ParsedContent(text=truncated, metadata=metadata)

    def _extract_text(self, path: Path) -> str:
        converters = [self._convert_with_pypandoc, self._convert_with_textutil,
                      self._convert_with_soffice, self._convert_with_md]
        for converter in converters:
            try:
                content = converter(path)
                if content:
                    return content
            except FileNotFoundError:
                continue
            except subprocess.CalledProcessError:
                continue
            except ImportError:
                continue
        raise ValueError(
            f"Unable to process .doc file {path}. Install pypandoc, or ensure 'textutil' (macOS) or 'soffice' is available."
        )

    def _convert_with_pypandoc(self, path: Path) -> Optional[str]:
        spec = importlib.util.find_spec("pypandoc")
        if spec is None:
            raise ImportError
        pypandoc = importlib.import_module("pypandoc")
        result = pypandoc.convert_file(str(path), "plain")
        return result.strip()

    def _convert_with_textutil(self, path: Path) -> Optional[str]:
        textutil = shutil.which("textutil")
        if not textutil:
            raise FileNotFoundError
        completed = subprocess.run(
            [textutil, "-stdout", "-convert", "txt", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        return completed.stdout.strip()

    def _convert_with_soffice(self, path: Path) -> Optional[str]:
        soffice = shutil.which("soffice")
        if not soffice:
            raise FileNotFoundError
        with tempfile.TemporaryDirectory() as tmpdir:
            subprocess.run(
                [soffice, "--headless", "--convert-to", "txt:Text", "--outdir", tmpdir, str(path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            txt_path = Path(tmpdir) / f"{path.stem}.txt"
            if not txt_path.exists():
                return None
            return txt_path.read_text(encoding="utf-8", errors="ignore").strip()

    def _convert_with_md(self, path: Path) -> Optional[str]:
        result = self.md.convert(str(path))
        text = result.text_content

        return text.strip()
