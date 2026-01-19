"""
LLM configuration management

Provides simple LLM configuration management
"""

import os
from typing import Optional
from services.memory.memory_layer.llm.openai_provider import OpenAIProvider


def create_provider(
    model: Optional[str] = None,  # None = use local model
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    **kwargs,
) -> OpenAIProvider:
    """
    Create an LLM provider (defaults to local VLM)

    Args:
        model: Model name (None for local model)
        api_key: API key, if None use environment variable
        base_url: Base URL, if None use local VLM
        temperature: Temperature
        max_tokens: Maximum token count
        **kwargs: Additional parameters

    Returns:
        Configured OpenAIProvider instance
    """
    return OpenAIProvider(
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )


def create_cheap_provider() -> OpenAIProvider:
    """Create a provider for simple tasks (uses local model)"""
    return create_provider(temperature=0.3, max_tokens=2048)


def create_high_quality_provider() -> OpenAIProvider:
    """Create a provider for complex tasks (uses local model with more tokens)"""
    return create_provider(temperature=0.5, max_tokens=4096)
