"""Storage service for the local RAG agent."""

from .activities import ActivityMixin
from .apikeys import ApiKeyMixin
from .base import StorageBase
from .chats import ChatMixin
from .emails import EmailMixin
from .files import FileMixin
from .notes import NoteMixin
from .search import SearchMixin
from .memory import MemoryMixin


class IndexStorage(
    StorageBase,
    ActivityMixin,
    ApiKeyMixin,
    ChatMixin,
    EmailMixin,
    FileMixin,
    NoteMixin,
    SearchMixin,
    MemoryMixin,
):
    """
    Storage handling file index, folders, email accounts/messages, notes,
    chat sessions, messages, activity logs, and user memories.
    """
    pass


# Export the class properly
__all__ = ["IndexStorage"]
