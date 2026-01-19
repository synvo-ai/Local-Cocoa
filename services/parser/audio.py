from __future__ import annotations

import subprocess
import tempfile
import logging
import json
from pathlib import Path

import httpx

from .base import BaseParser, ParsedContent
from services.core.config import settings

logger = logging.getLogger(__name__)


class AudioParser(BaseParser):
    extensions = {"mp3", "wav", "m4a", "flac", "aac", "ogg"}

    def __init__(self, *, ffmpeg_binary: str = "ffmpeg", max_chars: int = 4000) -> None:
        super().__init__(max_chars=max_chars)
        self.ffmpeg_binary = ffmpeg_binary

    def parse(self, path: Path, on_progress=None) -> ParsedContent:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_name = tmp.name

        try:
            if on_progress:
                on_progress("Converting audio...", 10)

            cmd = [
                self.ffmpeg_binary,
                "-y",
                "-i",
                str(path),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "wav",
                tmp_name,
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            audio_bytes = Path(tmp_name).read_bytes()
        except subprocess.CalledProcessError as e:
            logger.error(f"FFmpeg failed for {path}: {e}")
            if on_progress:
                on_progress(f"Error: Audio conversion failed {e}", 0)
            # Return empty but with error attachment if possible, or just fail logic
            return ParsedContent("", {"source": "audio", "error": "conversion_failed"})
        finally:
            if Path(tmp_name).exists():
                Path(tmp_name).unlink()

        text = ""
        vtt_content = None

        # Transcribe if endpoint is available
        if settings.endpoints.transcription:
            endpoint = f"{settings.endpoints.transcription.rstrip('/')}/inference"
            try:
                if on_progress:
                    on_progress("Transcribing audio...", 30)

                # We need extensive timeout for audio transcription
                with httpx.Client(timeout=600.0) as client:
                    # 1. Get JSON for clean text
                    files = {"file": ("audio.wav", audio_bytes, "audio/wav")}
                    data = {
                        "temperature": "0.0",
                        "temperature_inc": "0.2",
                        "response_format": "json"
                    }
                    resp = client.post(endpoint, files=files, data=data)
                    resp.raise_for_status()
                    resp_json = resp.json()
                    text = resp_json.get("text", "")

                    if on_progress:
                        on_progress("Transcribing audio...", 60)

                    # 2. Get VTT for attachment (Optional but requested)
                    files_vtt = {"file": ("audio.wav", audio_bytes, "audio/wav")}
                    data_vtt = {**data, "response_format": "vtt"}
                    resp_vtt = client.post(endpoint, files=files_vtt, data=data_vtt)
                    if resp_vtt.is_success:
                        vtt_content = resp_vtt.text.encode("utf-8")

            except Exception as e:
                logger.error(f"Audio transcription failed for {path}: {e}")
                if on_progress:
                    on_progress(f"Transcription failed: {str(e)[:100]}", 0)

        metadata = {"source": "audio"}
        attachments = {"audio_wav": audio_bytes}
        if vtt_content:
            attachments["transcription.vtt"] = vtt_content

        truncated = self._truncate(text)

        return ParsedContent(
            text=truncated,
            metadata=metadata,
            preview_image=None,
            duration_seconds=None,
            attachments=attachments,
        )
