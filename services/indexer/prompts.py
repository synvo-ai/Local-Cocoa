"""Prompts used by the indexing pipeline.

This module provides backward-compatible prompt constants that use the i18n system.
For multilingual support, use services.core.i18n.get_prompt() directly.
"""
from services.core.i18n import I18nPrompts, get_prompt

# Backward-compatible constants (English by default)
DEFAULT_SUMMARY_PROMPT = I18nPrompts.get_summary_prompt("en")
IMAGE_PROMPT = I18nPrompts.get_image_prompt("en")
PDF_PAGE_PROMPT = I18nPrompts.get_pdf_page_prompt("en")
VIDEO_SEGMENT_PROMPT = I18nPrompts.get_video_segment_prompt("en")
CHUNK_QUESTIONS_PROMPT = I18nPrompts.get_chunk_questions_prompt("en")

# Export the get_prompt function for direct use
__all__ = [
    "DEFAULT_SUMMARY_PROMPT",
    "IMAGE_PROMPT",
    "PDF_PAGE_PROMPT",
    "VIDEO_SEGMENT_PROMPT",
    "CHUNK_QUESTIONS_PROMPT",
    "get_prompt",
]
