"""Stage-based processors for two-round indexing pipeline."""

from .fast_text import FastTextProcessor
from .fast_embed import FastEmbedProcessor
from .deep import DeepProcessor

__all__ = ["FastTextProcessor", "FastEmbedProcessor", "DeepProcessor"]

