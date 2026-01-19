from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import logging
import subprocess
import tempfile
import httpx

import cv2

from services.core.config import settings
from .base import BaseParser, ParsedContent

logger = logging.getLogger(__name__)


@dataclass
class VideoSegment:
    """Represents a 30-second video segment with multiple frames."""
    frames: list[bytes]  # 8 frames uniformly sampled from this segment
    start_time: float    # Start timestamp in seconds
    end_time: float      # End timestamp in seconds
    segment_index: int   # Segment number (0, 1, 2, ...)


class VideoParser(BaseParser):
    extensions = {"mp4", "mov", "mkv", "avi", "webm"}

    def __init__(self, *, max_chars: int = 4000, segment_duration: int = 30, frames_per_segment: int = 8) -> None:
        """
        Initialize VideoParser.

        Args:
            max_chars: Maximum characters for text content
            segment_duration: Duration of each segment in seconds (default: 30)
            frames_per_segment: Number of frames to extract per segment (default: 8, including start and end frames)
        """
        super().__init__(max_chars=max_chars)
        self.segment_duration = segment_duration
        self.frames_per_segment = frames_per_segment

    def parse(self, path: Path, on_progress=None) -> ParsedContent:
        capture = cv2.VideoCapture(str(path))
        if not capture.isOpened():
            raise RuntimeError(f"Unable to open video file: {path}")

        frame_total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        duration = frame_total / fps if fps > 0 else 0.0

        # Extract and Transcribe Audio
        transcript_segments = []
        full_transcript_text = ""
        
        if settings.endpoints.transcription:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_name = tmp.name
            try:
                # Extract audio
                if on_progress:
                    on_progress("Extracting audio...", 10)

                subprocess.run(
                    ["ffmpeg", "-y", "-i", str(path), "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", tmp_name],
                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                audio_bytes = Path(tmp_name).read_bytes()
                
                # Transcribe
                if on_progress:
                     on_progress("Transcribing audio...", 25)

                endpoint = f"{settings.endpoints.transcription.rstrip('/')}/inference"
                with httpx.Client(timeout=600.0) as client:
                    files = {"file": ("audio.wav", audio_bytes, "audio/wav")}
                    data = {"temperature": "0.0", "temperature_inc": "0.2", "response_format": "vtt"}
                    resp = client.post(endpoint, files=files, data=data)
                    if resp.is_success:
                         vtt_content = resp.text
                         transcript_segments = self._parse_vtt(vtt_content)
                         full_transcript_text = " ".join([s["text"] for s in transcript_segments])
            except Exception as e:
                logger.warning(f"Video transcription failed for {path}: {e}")
                if on_progress:
                     on_progress(f"Transcription warning: {str(e)[:50]}", 25)
            finally:
                if Path(tmp_name).exists():
                    Path(tmp_name).unlink()

        # Divide video into segments
        if on_progress:
             on_progress("Extracting frame segments...", 50)

        segments: list[VideoSegment] = []
        segment_index = 0
        current_start = 0.0

        while current_start < duration:
            # Calculate segment boundaries
            segment_end = min(current_start + self.segment_duration, duration)

            # Extract frames uniformly from this segment (including start and end)
            segment_frames = self._extract_segment_frames(
                capture, current_start, segment_end, fps, frame_total
            )

            if segment_frames:
                segments.append(VideoSegment(
                    frames=segment_frames,
                    start_time=current_start,
                    end_time=segment_end,
                    segment_index=segment_index
                ))
                segment_index += 1

            current_start += self.segment_duration

        capture.release()

        metadata = {
            "source": "video",
            "segments_count": len(segments),
            "duration": duration,
            "fps": fps,
            "segment_duration": self.segment_duration,
            "frames_per_segment": self.frames_per_segment,
        }

        # Store all segments data
        attachments = {}
        if segments:
            # Store segment info for processing
            segments_data = []
            for seg in segments:
                # Associate transcript text with segment
                seg_text = ""
                if transcript_segments:
                    parts = []
                    for block in transcript_segments:
                         mid = (block["start"] + block["end"]) / 2
                         if seg.start_time <= mid < seg.end_time:
                             parts.append(block["text"])
                    seg_text = " ".join(parts)

                segments_data.append({
                    "frames": seg.frames,
                    "start_time": seg.start_time,
                    "end_time": seg.end_time,
                    "index": seg.segment_index,
                    "text": seg_text
                })
            attachments["video_segments"] = segments_data
        
        # Add full transcript if available
        if full_transcript_text:
             attachments["transcription"] = full_transcript_text

        # Use first frame of first segment as preview
        preview_image = segments[0].frames[0] if segments and segments[0].frames else None

        return ParsedContent(
            text=full_transcript_text, # Use full transcript as the main text content
            metadata=metadata,
            preview_image=preview_image,
            duration_seconds=duration,
            attachments=attachments,
        )

    def _extract_segment_frames(
        self, capture: cv2.VideoCapture, start_time: float, end_time: float, fps: float, frame_total: int
    ) -> list[bytes]:
        """Extract uniformly distributed frames from a video segment."""
        start_frame = int(start_time * fps)
        end_frame = min(int(end_time * fps), frame_total - 1)

        if start_frame >= frame_total or start_frame >= end_frame:
            return []

        # Calculate frame indices to extract (uniformly distributed, including start and end)
        frames_in_segment = end_frame - start_frame + 1
        if frames_in_segment <= self.frames_per_segment:
            # If segment has fewer frames than requested, take all
            frame_indices = list(range(start_frame, end_frame + 1))
        else:
            # Uniformly sample frames_per_segment frames including start and end
            frame_indices = [
                start_frame + int(i * (end_frame - start_frame) / (self.frames_per_segment - 1))
                for i in range(self.frames_per_segment)
            ]

        extracted_frames = []
        # Use video-specific resolution (lower than images for faster processing)
        max_pixels = settings.video_max_pixels

        for frame_idx in frame_indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            success, frame = capture.read()

            if success:
                # Resize if needed
                height, width = frame.shape[:2]
                if max_pixels > 0 and width * height > max_pixels:
                    ratio = (max_pixels / (width * height)) ** 0.5
                    new_width = int(width * ratio)
                    new_height = int(height * ratio)
                    frame = cv2.resize(frame, (new_width, new_height), interpolation=cv2.INTER_AREA)

                # Encode frame to JPEG
                _, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                extracted_frames.append(buffer.tobytes())

        return extracted_frames

    def _parse_vtt(self, vtt_content: str) -> list[dict]:
        blocks = []
        lines = vtt_content.splitlines()
        current_block = {}
        
        for line in lines:
            line = line.strip()
            if "-->" in line:
                try:
                    start_str, end_str = line.split("-->")
                    current_block["start"] = self._parse_time(start_str.strip())
                    current_block["end"] = self._parse_time(end_str.strip())
                except Exception:
                    continue
            elif line and "start" in current_block:
                # Accumulate text
                current_text = current_block.get("text", "")
                current_block["text"] = (current_text + " " + line).strip()
            elif not line and "text" in current_block:
                blocks.append(current_block)
                current_block = {}
                
        # Handle last block
        if "text" in current_block and "start" in current_block:
            blocks.append(current_block)
            
        return blocks

    def _parse_time(self, time_str: str) -> float:
        try:
            # Format: HH:MM:SS.mmm or MM:SS.mmm
            parts = time_str.split(":")
            seconds = 0.0
            if len(parts) == 3:
                seconds += float(parts[0]) * 3600
                seconds += float(parts[1]) * 60
                seconds += float(parts[2])
            elif len(parts) == 2:
                seconds += float(parts[0]) * 60
                seconds += float(parts[1])
            return seconds
        except Exception:
            return 0.0
