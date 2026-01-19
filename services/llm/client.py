from __future__ import annotations

import base64
import json
import math
import logging
import os
import io
from typing import Any, AsyncIterable, Iterable, Optional, Sequence

import httpx
from PIL import Image

from services.core.config import settings


logger = logging.getLogger(__name__)


def _has_repeated_ngram(text: str, n: int = 6) -> bool:
    """
    Detect whether the given text contains any repeated n-gram (default: 6-gram).

    We use simple whitespace tokenisation which is sufficient for blocking
    obviously repetitive outputs from the VLM.
    """
    if not text:
        return False

    tokens = text.split()
    if len(tokens) < n * 2:  # Need at least two n-grams to have a repeat
        return False

    seen: set[tuple[str, ...]] = set()
    for i in range(len(tokens) - n + 1):
        gram = tuple(tokens[i: i + n])
        if gram in seen:
            return True
        seen.add(gram)
    return False


class EmbeddingClient:
    timeout: float = 30.0

    async def encode(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        base = settings.endpoints.embedding.rstrip("/")
        endpoints: list[str] = []

        if base.endswith("/v1/embeddings"):
            endpoints.append(base)
        else:
            endpoints.append(f"{base}/v1/embeddings")

        errors: list[str] = []
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for endpoint in endpoints:
                try:
                    if endpoint.endswith("/v1/embeddings"):
                        payload: dict[str, Any] = {"input": texts}
                        model = os.getenv("LOCAL_EMBEDDING_MODEL")
                        if model:
                            payload["model"] = model
                    else:
                        payload = {"texts": texts}

                    response = await client.post(endpoint, json=payload)
                    response.raise_for_status()
                    data = response.json()

                    if "embedding" in data and isinstance(data["embedding"], list):
                        vector = [float(value) for value in data["embedding"]]
                        return [vector]

                    if "embeddings" in data and isinstance(data["embeddings"], list):
                        return [list(map(float, vector)) for vector in data["embeddings"]]

                    if "data" in data and isinstance(data["data"], list):
                        vectors: list[list[float]] = []
                        for item in data["data"]:
                            embedding = item.get("embedding")
                            if embedding is None:
                                continue
                            vectors.append([float(value) for value in embedding])
                        if vectors:
                            return vectors

                    raise ValueError("Unexpected embedding response schema")
                except (httpx.HTTPError, ValueError) as exc:
                    errors.append(f"{endpoint}: {exc}")
                    continue

        raise RuntimeError("Failed to obtain embeddings from configured endpoint(s): " + "; ".join(errors))


class RerankClient:
    timeout: float = 30.0

    async def rerank(self, query: str, documents: Sequence[str], top_k: int = 5) -> list[tuple[int, float]]:
        if not documents:
            return []
        payload = {"query": query, "documents": list(documents), "top_k": top_k}

        base = settings.endpoints.rerank.rstrip("/")
        candidates: list[str]
        if base.endswith("/rerank") or base.endswith("/v1/rerank"):
            candidates = [base]
        else:
            candidates = [f"{base}/v1/rerank", f"{base}/rerank"]

        logger.debug("Rerank candidates: %s", candidates)

        errors: list[str] = []
        data: dict[str, Any] = {}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for endpoint in candidates:
                try:
                    response = await client.post(endpoint, json=payload)
                    logger.debug("Rerank response from %s: %s", endpoint, response.text)
                    response.raise_for_status()
                    data = response.json()
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning("Rerank endpoint %s failed: %s", endpoint, exc)
                    errors.append(f"{endpoint}: {exc}")
                    continue
            else:
                logger.error("Failed to obtain rerank results: %s", "; ".join(errors))
                raise RuntimeError("Failed to obtain rerank results: " + "; ".join(errors))

        # Allow different reranker payload schemas (llama.cpp vs Cohere/OpenAI).
        results = data.get("results") or data.get("data") or []
        logger.debug("Rerank results payload: %s", results)

        ranked: list[tuple[int, float]] = []
        for position, item in enumerate(results):
            idx = item.get("index", position)
            score = item.get("score")
            if score is None:
                score = item.get("relevance_score")
            if score is None:
                # Some APIs nest the score under a document payload.
                document = item.get("document") or {}
                score = document.get("score")
            try:
                idx = int(idx)
            except (TypeError, ValueError):
                continue
            try:
                score = float(score)
            except (TypeError, ValueError):
                continue
            ranked.append((idx, score))

        logger.debug("Final ranked list: %s", ranked)
        return ranked


class LlmClient:
    timeout: float = 120.0

    async def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
        temperature: float | None = None,
        repeat_penalty: float | None = None,
        frequency_penalty: float | None = None,
        presence_penalty: float | None = None,
        repeat_last_n: int | None = None,
    ) -> str:
        processed_system = self._truncate_system(system)
        prompt_budget = self._prompt_budget(processed_system)
        processed_prompt = self._truncate_text(prompt, prompt_budget)
        payload: dict[str, Any] = {"prompt": processed_prompt,
                                   "max_tokens": min(max_tokens, settings.llm_context_tokens)}
        if processed_system:
            payload["system"] = processed_system
        if temperature is not None:
            payload["temperature"] = temperature
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty
        if frequency_penalty is not None:
            payload["frequency_penalty"] = frequency_penalty
        if presence_penalty is not None:
            payload["presence_penalty"] = presence_penalty
        if repeat_last_n is not None:
            payload["repeat_last_n"] = repeat_last_n

        base = settings.endpoints.llm.rstrip("/")
        endpoints: list[str] = []
        if base.endswith("/completion") or base.endswith("/generate") or base.endswith("/v1/completions"):
            endpoints.append(base)
        else:
            endpoints.append(f"{base}/completion")
            endpoints.append(f"{base}/generate")
            endpoints.append(f"{base}/v1/completions")

        errors: list[str] = []
        logger.info(f"🔧 LLM Request: max_tokens={payload.get('max_tokens')}")
        logger.debug(f"🔧 LLM Request payload: {payload}")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for endpoint in endpoints:
                try:
                    logger.info(f"📡 Calling LLM endpoint: {endpoint}")
                    response = await client.post(endpoint, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    logger.info(f"📥 LLM Response data keys: {list(data.keys())}")
                    text = data.get("text")
                    if text is None and "content" in data:
                        text = data["content"]
                    if text is None and "choices" in data and len(data["choices"]) > 0:
                        text = data["choices"][0].get("text")
                    if text is not None:
                        logger.info(f"✅ LLM returned text length: {len(text)} chars")
                        return str(text)
                    raise ValueError("Unexpected LLM response schema")
                except (httpx.HTTPError, ValueError) as exc:
                    error_details = ""
                    if isinstance(exc, httpx.HTTPStatusError):
                        try:
                            error_details = f" Response: {exc.response.text}"
                        except Exception:
                            pass
                    logger.warning(f"❌ LLM endpoint {endpoint} failed: {type(exc).__name__}: {exc}{error_details}")
                    errors.append(f"{endpoint}: {type(exc).__name__}: {exc}{error_details}")
                    continue

        raise RuntimeError("Failed to obtain completion from configured LLM endpoint(s): " + "; ".join(errors))

    def _prompt_budget(self, system_text: Optional[str]) -> int:
        total = settings.llm_max_prompt_tokens
        if not system_text:
            return total
        system_tokens = self._estimate_tokens(system_text)
        remaining = total - system_tokens
        reserve = max(total // 2, 1024)
        return max(remaining, reserve)

    def _truncate_system(self, system_text: Optional[str]) -> Optional[str]:
        if not system_text:
            return None
        budget = max(settings.llm_max_prompt_tokens // 8, 512)
        return self._truncate_text(system_text, budget)

    def _truncate_text(self, text: str, max_tokens: int) -> str:
        if max_tokens <= 0:
            return text
        ratio = settings.llm_chars_per_token
        max_chars = max_tokens * ratio
        if len(text) <= max_chars:
            return text
        marker = "\n\n...[clipped]...\n\n"
        if max_chars <= len(marker) + 1:
            return text[:max_chars]
        head = max_chars // 2
        tail = max_chars - head - len(marker)
        if tail <= 0:
            return text[:max_chars]
        return text[:head] + marker + text[-tail:]

    def _estimate_tokens(self, text: str) -> int:
        if not text:
            return 0
        ratio = settings.llm_chars_per_token
        return max(math.ceil(len(text) / ratio), 1)

    async def chat(self, messages: list[dict[str, Any]], *, stream: bool = False) -> dict[str, Any]:
        payload = {"messages": messages, "stream": stream}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{settings.endpoints.llm}/chat", json=payload)
            response.raise_for_status()
            return response.json()

    async def chat_complete(
        self,
        messages: list[dict[str, Any]],
        *,
        max_tokens: int = 512,
        temperature: float | None = None,
        repeat_penalty: float | None = None,
        frequency_penalty: float | None = None,
        presence_penalty: float | None = None,
        repeat_last_n: int | None = None,
    ) -> str:
        """Use chat completion API for better VLM responses."""
        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty
        if frequency_penalty is not None:
            payload["frequency_penalty"] = frequency_penalty
        if presence_penalty is not None:
            payload["presence_penalty"] = presence_penalty
        if repeat_last_n is not None:
            payload["repeat_last_n"] = repeat_last_n

        base = settings.endpoints.llm.rstrip("/")
        endpoints: list[str] = [
            f"{base}/v1/chat/completions",
            f"{base}/chat/completions",
            f"{base}/chat",
        ]

        errors: list[str] = []
        logger.info(f"🔧 Chat Request: messages={len(messages)}, max_tokens={max_tokens}")
        logger.debug(f"🔧 Chat Request payload: {payload}")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for endpoint in endpoints:
                try:
                    logger.info(f"📡 Calling Chat endpoint: {endpoint}")
                    response = await client.post(endpoint, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    logger.info(f"📥 Chat Response data keys: {list(data.keys())}")

                    # OpenAI-style response
                    if "choices" in data and len(data["choices"]) > 0:
                        content = data["choices"][0].get("message", {}).get("content", "")
                        if content:
                            logger.info(f"✅ Chat returned text length: {len(content)} chars")
                            return str(content)

                    # llama.cpp style response
                    if "content" in data:
                        logger.info(f"✅ Chat returned text length: {len(data['content'])} chars")
                        return str(data["content"])

                    raise ValueError("Unexpected chat response schema")
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning(f"❌ Chat endpoint {endpoint} failed: {exc}")
                    errors.append(f"{endpoint}: {exc}")
                    continue

        raise RuntimeError("Failed to obtain chat completion from configured LLM endpoint(s): " + "; ".join(errors))

    async def describe_frames(
        self,
        frames: Sequence[bytes],
        *,
        prompt: str,
        system: str | None = None,
        preset: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        if settings.endpoints.vision is None:
            raise RuntimeError("Vision endpoint is not configured.")

        # Convert frames to data URLs for llama.cpp
        images_content = []
        for frame in frames:
            # Resize frame if needed
            processed_frame = self._resize_image(frame)
            encoded = base64.b64encode(processed_frame).decode("ascii")
            images_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{encoded}"
                }
            })

        # Build content array with images first, then prompt
        content = images_content + [{"type": "text", "text": prompt}]

        # Build messages for llama.cpp's /v1/chat/completions API
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})
        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.7,
            "stream": False,
        }

        logger.info(f"🔧 Vision describe_frames request: max_tokens={max_tokens}")

        # Apply 6-gram blocking with up to 3 attempts.
        last_text = ""
        last_error: str | None = None
        async with httpx.AsyncClient(timeout=60.0) as client:
            for attempt in range(3):
                try:
                    response = await client.post(
                        f"{settings.endpoints.vision}/v1/chat/completions",
                        json=payload,
                    )
                    response.raise_for_status()
                    data = response.json()
                except httpx.HTTPStatusError as exc:
                    body = (exc.response.text or "").strip()
                    body_preview = body[:500]
                    last_error = f"HTTP {exc.response.status_code} from vision endpoint: {body_preview}" if body_preview else f"HTTP {exc.response.status_code} from vision endpoint"
                    logger.warning("Vision describe_frames failed (attempt %d/3): %s", attempt + 1, last_error)
                    continue
                except (httpx.RequestError, ValueError, json.JSONDecodeError) as exc:
                    last_error = f"Vision describe_frames request failed (attempt {attempt + 1}/3): {type(exc).__name__}: {exc}"
                    logger.warning("%s", last_error)
                    continue

                # Extract text from OpenAI-style response
                text = ""
                if "choices" in data and len(data["choices"]) > 0:
                    text = data["choices"][0].get("message", {}).get("content", "") or ""

                last_text = text
                if not _has_repeated_ngram(text, n=6):
                    return text

                logger.info(
                    "6-gram blocking triggered for vision describe_frames (attempt %d/3).",
                    attempt + 1,
                )

            # If the third attempt still fails blocking, just return the last response.
            if last_text:
                return last_text

            if last_error:
                raise RuntimeError(last_error)
            raise RuntimeError("Vision describe_frames returned no text.")

    def _resize_image(self, image_bytes: bytes) -> bytes:
        """Resize image if it exceeds the configured max pixels."""
        max_pixels = settings.vision_max_pixels
        if max_pixels <= 0:
            return image_bytes

        try:
            with Image.open(io.BytesIO(image_bytes)) as img:
                width, height = img.size
                if width * height <= max_pixels:
                    return image_bytes

                # Calculate new size maintaining aspect ratio
                ratio = (max_pixels / (width * height)) ** 0.5
                new_width = int(width * ratio)
                new_height = int(height * ratio)

                # Resize
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

                # Save back to bytes
                buffer = io.BytesIO()
                # Convert to RGB if needed (e.g. RGBA) to save as JPEG
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                img.save(buffer, format="JPEG", quality=85)
                return buffer.getvalue()
        except Exception as e:
            logger.warning(f"Failed to resize image: {e}")
            return image_bytes

    def _estimate_max_frames_for_context(self) -> int:
        """
        Estimate the maximum number of video frames that can fit in the context window.

        Based on:
        - llm_context_tokens: total context size
        - video_max_pixels: resolution per frame (uses video-specific setting, lower than images)

        For Qwen3VL and similar models, image tokens are roughly:
        - pixels / 400 (conservative estimate based on patch size)
        """
        context_size = settings.llm_context_tokens
        # Use video-specific resolution (typically lower than image resolution)
        max_pixels = settings.video_max_pixels

        # Estimate tokens per frame (conservative)
        # Most VLMs use ~14x14 or ~28x28 patches, roughly 1 token per 300-500 pixels
        tokens_per_frame = max(max_pixels // 400, 500)  # minimum 500 tokens per frame

        # Reserve tokens for prompt (~300) and output (~300)
        reserved_tokens = 600
        available_tokens = context_size - reserved_tokens

        # Calculate max frames
        max_frames = max(1, available_tokens // tokens_per_frame)

        # Cap at reasonable limits (1-4 frames)
        max_frames = min(max_frames, 4)

        logger.info(
            f"🧮 Video context budget: {context_size} tokens, {max_pixels} pixels/frame, ~{tokens_per_frame} tokens/frame → max {max_frames} frames")
        return max_frames

    async def describe_video_segment(
        self,
        frames: Sequence[bytes],
        start_time: float,
        end_time: float,
        *,
        prompt: str,
        system: str | None = None,
        max_frames: int | None = None,
    ) -> str:
        """
        Describe a video segment by analyzing multiple frames from that time range.

        Args:
            frames: List of frame images (JPEG bytes) from this segment
            start_time: Start time of the segment in seconds
            end_time: End time of the segment in seconds
            prompt: Base prompt for description
            system: Optional system message
            max_frames: Maximum number of frames to send to VLM. 
                        If None, auto-calculated based on context size and vision resolution.

        Returns:
            Description of what happens in this time segment
        """
        if settings.endpoints.vision is None:
            raise RuntimeError("Vision endpoint is not configured.")

        # Auto-calculate max frames if not specified
        if max_frames is None:
            max_frames = self._estimate_max_frames_for_context()

        # Format timestamp as MM:SS
        def format_time(seconds: float) -> str:
            mins = int(seconds // 60)
            secs = int(seconds % 60)
            return f"{mins:02d}:{secs:02d}"

        # Build time-aware prompt
        time_range = f"{format_time(start_time)} - {format_time(end_time)}"
        full_prompt = f"{prompt}\n\nTime range: {time_range}\nDescribe what happens in this segment."

        # Limit frames to avoid GPU memory issues
        # Select first, middle, and last frames if we have more than max_frames
        if len(frames) > max_frames:
            if max_frames == 1:
                selected_frames = [frames[len(frames) // 2]]  # middle frame
            elif max_frames == 2:
                selected_frames = [frames[0], frames[-1]]  # first and last
            else:
                # Uniformly sample frames
                step = len(frames) / max_frames
                selected_frames = [frames[int(i * step)] for i in range(max_frames)]
        else:
            selected_frames = list(frames)

        logger.info(
            f"🎬 Video segment {time_range}: using {len(selected_frames)}/{len(frames)} frames (context allows {max_frames})")

        # Convert frames to data URLs
        images_content = []
        for frame in selected_frames:
            # Resize frame if needed
            processed_frame = self._resize_image(frame)
            encoded = base64.b64encode(processed_frame).decode("ascii")
            images_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{encoded}"
                }
            })

        # Build content array with images first, then prompt
        content = images_content + [{"type": "text", "text": full_prompt}]

        # Build messages
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})
        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": 256,  # Shorter captions per segment
            "temperature": 0.7,
            "stream": False,
        }

        # Apply 6-gram blocking with up to 3 attempts.
        last_caption = ""
        async with httpx.AsyncClient(timeout=90.0) as client:
            for attempt in range(3):
                response = await client.post(
                    f"{settings.endpoints.vision}/v1/chat/completions",
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()

                caption = ""
                if "choices" in data and len(data["choices"]) > 0:
                    caption = (
                        data["choices"][0]
                        .get("message", {})
                        .get("content", "")
                        .strip()
                    )

                last_caption = caption
                if not _has_repeated_ngram(caption, n=6):
                    # Return with timestamp prefix
                    return f"{time_range} -> {caption}" if caption else ""

                logger.info(
                    "6-gram blocking triggered for vision describe_video_segment (attempt %d/3).",
                    attempt + 1,
                )

            # If the third attempt still fails blocking, just return the last response.
            return f"{time_range} -> {last_caption}" if last_caption else ""

    async def stream_complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
        temperature: float | None = None,
        repeat_penalty: float | None = None,
    ) -> AsyncIterable[str]:
        processed_system = self._truncate_system(system)
        prompt_budget = self._prompt_budget(processed_system)
        processed_prompt = self._truncate_text(prompt, prompt_budget)
        payload: dict[str, Any] = {
            "prompt": processed_prompt,
            "max_tokens": min(max_tokens, settings.llm_context_tokens),
            "stream": True
        }
        if processed_system:
            payload["system"] = processed_system
        if temperature is not None:
            payload["temperature"] = temperature
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty

        base = settings.endpoints.llm.rstrip("/")
        endpoints: list[str] = []
        if base.endswith("/completion") or base.endswith("/generate") or base.endswith("/v1/completions"):
            endpoints.append(base)
        else:
            endpoints.append(f"{base}/completion")
            endpoints.append(f"{base}/generate")
            endpoints.append(f"{base}/v1/completions")

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            # Try endpoints until one works
            for endpoint in endpoints:
                try:
                    async with client.stream("POST", endpoint, json=payload) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.strip():
                                continue
                            if line.startswith("data: "):
                                data_str = line[6:]
                                if data_str == "[DONE]":
                                    break
                                try:
                                    data = json.loads(data_str)
                                    text = data.get("content") or data.get("text")
                                    if text:
                                        yield text
                                except json.JSONDecodeError:
                                    continue
                    return
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning(f"Streaming failed for endpoint {endpoint}: {exc}")
                    continue

            raise RuntimeError("Failed to stream completion from configured LLM endpoint(s)")

    async def stream_chat_complete(
        self,
        messages: list[dict[str, Any]],
        *,
        max_tokens: int = 512,
        temperature: float | None = None,
        repeat_penalty: float | None = None,
        frequency_penalty: float | None = None,
        presence_penalty: float | None = None,
    ) -> AsyncIterable[str]:
        """
        Stream chat completion using /v1/chat/completions API.

        This applies the model's chat template for better response quality
        compared to raw text completion.
        """
        payload: dict[str, Any] = {
            "messages": messages,
            "max_tokens": min(max_tokens, settings.llm_context_tokens),
            "stream": True,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty
        if frequency_penalty is not None:
            payload["frequency_penalty"] = frequency_penalty
        if presence_penalty is not None:
            payload["presence_penalty"] = presence_penalty

        base = settings.endpoints.llm.rstrip("/")
        endpoints: list[str] = [
            f"{base}/v1/chat/completions",
            f"{base}/chat/completions",
        ]

        logger.info(f"🔧 Stream Chat Request: messages={len(messages)}, max_tokens={max_tokens}")

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for endpoint in endpoints:
                try:
                    logger.info(f"📡 Streaming from Chat endpoint: {endpoint}")
                    async with client.stream("POST", endpoint, json=payload) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.strip():
                                continue
                            if line.startswith("data: "):
                                data_str = line[6:]
                                if data_str.strip() == "[DONE]":
                                    break
                                try:
                                    data = json.loads(data_str)
                                    # OpenAI-style streaming response
                                    if "choices" in data and len(data["choices"]) > 0:
                                        delta = data["choices"][0].get("delta", {})
                                        content = delta.get("content")
                                        if content:
                                            yield content
                                    # llama.cpp style streaming response
                                    elif "content" in data:
                                        if data["content"]:
                                            yield data["content"]
                                except json.JSONDecodeError:
                                    continue
                    return
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning(f"❌ Stream chat failed for endpoint {endpoint}: {exc}")
                    continue

            raise RuntimeError("Failed to stream chat completion from configured LLM endpoint(s)")


class TranscriptionClient:
    timeout: float = 300.0

    async def transcribe(self, audio_bytes: bytes, *, language: str = "en", response_format: str = "json") -> str | dict:
        if settings.endpoints.transcription is None:
            raise RuntimeError("Transcription endpoint is not configured.")

        endpoint = f"{settings.endpoints.transcription.rstrip('/')}/inference"

        # whisper.cpp server expects file field named 'file'
        files = {"file": ("audio.wav", audio_bytes, "audio/wav")}
        data = {
            "temperature": "0.0",
            "temperature_inc": "0.2",
            "response_format": response_format,
            "language": language,  # Pass language to whisper.cpp
            "translate": "false",  # Keep original language, don't translate to English
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(endpoint, files=files, data=data)
            response.raise_for_status()

            if response_format == "json":
                return response.json()
            return response.text


async def gather_embeddings(client: EmbeddingClient, texts: Iterable[str]) -> list[list[float]]:
    batch = list(texts)
    if not batch:
        return []
    return await client.encode(batch)
