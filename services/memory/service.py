"""
Memory Service - High-level interface for memory management

Uses SQLite for persistent storage (via IndexStorage) and Qdrant for vector search.
"""

from typing import List, Optional
from datetime import datetime, timezone
import uuid

from services.memory.models import (
    MemorizeRequest,
    MemorizeResult,
    SearchMemoryRequest,
    SearchMemoryResult,
    MemoryRecord,
    EpisodeRecord,
    ProfileRecord,
    ForesightRecord,
    EventLogRecord,
    UserMemorySummary,
)
from services.memory.memory_layer.memory_manager import MemoryManager
from services.memory.memory_layer.memcell_extractor.base_memcell_extractor import RawData
from services.memory.api_specs.memory_types import RawDataType, MemoryType
from services.memory.core.observation.logger import get_logger

# Import storage records
from services.storage.memory import (
    EpisodeRecord as StorageEpisodeRecord,
    EventLogRecord as StorageEventLogRecord,
    ForesightRecord as StorageForesightRecord,
    ProfileRecord as StorageProfileRecord,
)

logger = get_logger(__name__)


class MemoryServiceError(Exception):
    """Base error for memory service"""
    pass


class MemoryNotFound(MemoryServiceError):
    """Memory not found error"""
    pass


class MemoryService:
    """
    Memory Service - Provides high-level memory management operations

    This service wraps the MemoryManager and provides a cleaner API
    for the FastAPI router. Uses SQLite for persistent storage.
    """

    def __init__(self):
        self._memory_manager: Optional[MemoryManager] = None
        self._storage = None  # Lazy loaded

    @property
    def storage(self):
        """Lazy load storage to avoid circular imports"""
        if self._storage is None:
            from services.core.context import get_storage
            self._storage = get_storage()
        return self._storage

    @property
    def memory_manager(self) -> MemoryManager:
        """Lazy initialization of MemoryManager"""
        if self._memory_manager is None:
            self._memory_manager = MemoryManager()
        return self._memory_manager

    async def memorize(self, request: MemorizeRequest) -> MemorizeResult:
        """
        Process raw data and extract memories

        Args:
            request: Memorization request with raw data

        Returns:
            MemorizeResult with counts of created memories
        """
        try:
            # Convert request data to RawData objects
            raw_data_list = [
                RawData(
                    content=item.content,
                    data_id=item.data_id,
                    data_type=item.data_type,
                    metadata=item.metadata,
                )
                for item in request.raw_data_list
            ]

            # Extract memcell first
            memcell, status = await self.memory_manager.extract_memcell(
                history_raw_data_list=[],
                new_raw_data_list=raw_data_list,
                raw_data_type=RawDataType.CONVERSATION,
                group_id=request.group_id,
                group_name=request.group_name,
                user_id_list=[request.user_id],
            )

            episodes_created = 0
            event_logs_created = 0
            foresights_created = 0
            profile_updated = False

            if memcell:
                # Extract episodic memory
                episode = await self.memory_manager.extract_memory(
                    memcell=memcell,
                    memory_type=MemoryType.EPISODIC_MEMORY,
                    user_id=request.user_id,
                )

                if episode:
                    # Store episode to SQLite
                    episode_id = str(uuid.uuid4())
                    now = datetime.now(timezone.utc).isoformat()

                    storage_episode = StorageEpisodeRecord(
                        id=episode_id,
                        user_id=request.user_id,
                        summary=getattr(episode, "summary", ""),
                        episode=getattr(episode, "episode", ""),
                        subject=getattr(episode, "subject", None),
                        timestamp=now,
                    )
                    self.storage.upsert_episode(storage_episode)
                    episodes_created = 1
                    logger.info(f"Stored episode {episode_id} for user {request.user_id}")

                    # Extract event logs if enabled
                    if request.enable_event_log:
                        event_log = await self.memory_manager.extract_memory(
                            memcell=memcell,
                            memory_type=MemoryType.EVENT_LOG,
                            user_id=request.user_id,
                            episode_memory=episode,
                        )
                        if event_log:
                            facts = getattr(event_log, "atomic_fact", [])
                            if isinstance(facts, str):
                                facts = [facts]

                            for fact in facts:
                                log_id = str(uuid.uuid4())
                                storage_log = StorageEventLogRecord(
                                    id=log_id,
                                    user_id=request.user_id,
                                    atomic_fact=fact,
                                    timestamp=now,
                                    parent_episode_id=episode_id,
                                )
                                self.storage.upsert_event_log(storage_log)
                                event_logs_created += 1

                            logger.info(f"Stored {event_logs_created} event logs for user {request.user_id}")

                    # Extract foresights if enabled
                    if request.enable_foresight:
                        foresight_list = await self.memory_manager.extract_memory(
                            memcell=memcell,
                            memory_type=MemoryType.FORESIGHT,
                            user_id=request.user_id,
                            episode_memory=episode,
                        )
                        if foresight_list:
                            items = foresight_list if isinstance(foresight_list, list) else [foresight_list]
                            for foresight in items:
                                fs_id = str(uuid.uuid4())
                                storage_foresight = StorageForesightRecord(
                                    id=fs_id,
                                    user_id=request.user_id,
                                    content=getattr(foresight, "foresight", ""),
                                    evidence=getattr(foresight, "evidence", None),
                                    parent_episode_id=episode_id,
                                )
                                self.storage.upsert_foresight(storage_foresight)
                                foresights_created += 1

                            logger.info(f"Stored {foresights_created} foresights for user {request.user_id}")

            return MemorizeResult(
                success=True,
                message="Memorization completed successfully",
                episodes_created=episodes_created,
                event_logs_created=event_logs_created,
                foresights_created=foresights_created,
                profile_updated=profile_updated,
            )

        except Exception as e:
            logger.error(f"Memorization failed: {e}")
            import traceback
            traceback.print_exc()
            return MemorizeResult(
                success=False,
                message=f"Memorization failed: {str(e)}",
            )

    async def search(self, request: SearchMemoryRequest) -> SearchMemoryResult:
        """
        Search user memories using FTS5 full-text search

        Args:
            request: Search request with query and filters

        Returns:
            SearchMemoryResult with matching memories
        """
        memories: List[MemoryRecord] = []

        try:
            # Use SQLite FTS5 search
            results = self.storage.search_memories(
                user_id=request.user_id,
                query=request.query,
                limit=request.limit,
            )

            for result in results:
                memories.append(MemoryRecord(
                    id=result["memory_id"],
                    user_id=request.user_id,
                    memory_type=result["memory_type"],
                    content=result["content"],
                    timestamp=datetime.now(timezone.utc),
                    score=abs(result["score"]),  # BM25 scores are negative
                ))

        except Exception as e:
            logger.error(f"Memory search failed: {e}")

        return SearchMemoryResult(
            memories=memories,
            total_count=len(memories),
            query=request.query,
            method=request.method.value,
        )

    async def get_user_summary(self, user_id: str) -> UserMemorySummary:
        """
        Get summary of user's memories

        Args:
            user_id: User ID

        Returns:
            UserMemorySummary with profile and memory counts
        """
        # Get profile from SQLite
        profile = None
        storage_profile = self.storage.get_profile(user_id)
        if storage_profile:
            profile = ProfileRecord(
                user_id=user_id,
                user_name=storage_profile.user_name,
                personality=storage_profile.personality,
                hard_skills=storage_profile.hard_skills,
                soft_skills=storage_profile.soft_skills,
                interests=storage_profile.interests,
            )

        # Count memories
        episodes_count = self.storage.count_episodes(user_id)
        event_logs_count = self.storage.count_event_logs(user_id)
        foresights_count = self.storage.count_foresights(user_id)

        # Get recent episodes
        storage_episodes = self.storage.get_episodes(user_id, limit=5)
        recent_episodes = [
            EpisodeRecord(
                id=ep.id,
                user_id=user_id,
                summary=ep.summary,
                episode=ep.episode,
                timestamp=datetime.fromisoformat(ep.timestamp) if ep.timestamp else datetime.now(timezone.utc),
                participants=[],
                subject=ep.subject,
                metadata=ep.metadata,
            )
            for ep in storage_episodes
        ]

        # Get recent foresights
        storage_foresights = self.storage.get_foresights(user_id, limit=5)
        recent_foresights = [
            ForesightRecord(
                id=fs.id,
                user_id=user_id,
                content=fs.content,
                evidence=fs.evidence,
                parent_episode_id=fs.parent_episode_id,
                metadata=fs.metadata,
            )
            for fs in storage_foresights
        ]

        return UserMemorySummary(
            user_id=user_id,
            profile=profile,
            episodes_count=episodes_count,
            event_logs_count=event_logs_count,
            foresights_count=foresights_count,
            recent_episodes=recent_episodes,
            recent_foresights=recent_foresights,
        )

    async def get_episodes(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> List[EpisodeRecord]:
        """Get user's episodic memories from SQLite"""
        storage_episodes = self.storage.get_episodes(user_id, limit=limit, offset=offset)

        return [
            EpisodeRecord(
                id=ep.id,
                user_id=user_id,
                summary=ep.summary,
                episode=ep.episode,
                timestamp=datetime.fromisoformat(ep.timestamp) if ep.timestamp else datetime.now(timezone.utc),
                participants=[],
                subject=ep.subject,
                metadata=ep.metadata,
            )
            for ep in storage_episodes
        ]

    async def get_event_logs(
        self,
        user_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> List[EventLogRecord]:
        """Get user's event logs from SQLite"""
        storage_logs = self.storage.get_event_logs(user_id, limit=limit, offset=offset)

        return [
            EventLogRecord(
                id=log.id,
                user_id=user_id,
                atomic_fact=log.atomic_fact,
                timestamp=datetime.fromisoformat(log.timestamp) if log.timestamp else datetime.now(timezone.utc),
                parent_episode_id=log.parent_episode_id,
                metadata=log.metadata,
            )
            for log in storage_logs
        ]

    async def get_foresights(
        self,
        user_id: str,
        limit: int = 50,
    ) -> List[ForesightRecord]:
        """Get user's foresights from SQLite"""
        storage_foresights = self.storage.get_foresights(user_id, limit=limit)

        return [
            ForesightRecord(
                id=fs.id,
                user_id=user_id,
                content=fs.content,
                evidence=fs.evidence,
                parent_episode_id=fs.parent_episode_id,
                metadata=fs.metadata,
            )
            for fs in storage_foresights
        ]


# Global instance
_memory_service: Optional[MemoryService] = None


def get_memory_service() -> MemoryService:
    """Get the global MemoryService instance"""
    global _memory_service
    if _memory_service is None:
        _memory_service = MemoryService()
    return _memory_service
