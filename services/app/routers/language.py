"""Language preference endpoint for i18n support."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.core.i18n import SupportedLanguage, DEFAULT_LANGUAGE
from services.core.config import settings
import logging

router = APIRouter(prefix="/language", tags=["language"])
logger = logging.getLogger(__name__)

# In-memory language preference (could be persisted to DB in future)
_current_language: SupportedLanguage = DEFAULT_LANGUAGE


class LanguagePreference(BaseModel):
    language: SupportedLanguage


class LanguageInfo(BaseModel):
    current: SupportedLanguage
    supported: list[str] = ["en", "zh", "ja", "ko", "fr", "de", "es", "ru"]


@router.get("", response_model=LanguageInfo)
def get_language() -> LanguageInfo:
    """Get current language preference."""
    return LanguageInfo(current=_current_language)


@router.post("", response_model=LanguageInfo)
def set_language(pref: LanguagePreference) -> LanguageInfo:
    """Set language preference."""
    global _current_language
    _current_language = pref.language
    logger.info(f"Language preference set to: {pref.language}")
    return LanguageInfo(current=_current_language)


def get_current_language() -> SupportedLanguage:
    """Get current language preference for use in other modules."""
    return _current_language

