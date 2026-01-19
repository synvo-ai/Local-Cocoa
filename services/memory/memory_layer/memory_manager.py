from dataclasses import dataclass
from datetime import datetime
import time
import os
import asyncio
from typing import List, Optional

from services.memory.core.observation.logger import get_logger

from services.memory.memory_layer.llm.llm_provider import LLMProvider
from services.memory.memory_layer.memcell_extractor.conv_memcell_extractor import ConvMemCellExtractor
from services.memory.memory_layer.memcell_extractor.base_memcell_extractor import RawData
from services.memory.memory_layer.memcell_extractor.conv_memcell_extractor import ConversationMemCellExtractRequest
from services.memory.api_specs.memory_types import MemCell, RawDataType, MemoryType, Foresight, BaseMemory, EpisodeMemory
from services.memory.memory_layer.memory_extractor.episode_memory_extractor import (
    EpisodeMemoryExtractor,
    EpisodeMemoryExtractRequest,
)
from services.memory.memory_layer.memory_extractor.profile_memory_extractor import (
    ProfileMemoryExtractor,
    ProfileMemoryExtractRequest,
)
from services.memory.memory_layer.memory_extractor.group_profile_memory_extractor import (
    GroupProfileMemoryExtractor,
    GroupProfileMemoryExtractRequest,
)
from services.memory.memory_layer.memory_extractor.event_log_extractor import EventLogExtractor
from services.memory.memory_layer.memory_extractor.foresight_extractor import ForesightExtractor
from services.memory.memory_layer.memcell_extractor.base_memcell_extractor import StatusResult


logger = get_logger(__name__)


class MemoryManager:
    """
    Memory Manager - Responsible for orchestrating all memory extraction processes

    Responsibilities:
    1. Extract MemCell (boundary detection + raw data)
    2. Extract Episode/Foresight/EventLog/Profile and other memories (based on MemCell or episode)
    3. Manage the lifecycle of all Extractors
    4. Provide a unified memory extraction interface
    """

    def __init__(self):
        # Get LLM URL from app settings (same as indexer/chat uses)
        # Priority: LLM_BASE_URL env > LOCAL_LLM_URL env > app settings > default
        from services.core.config import settings
        llm_url = os.getenv("LLM_BASE_URL") or os.getenv("LOCAL_LLM_URL") or settings.endpoints.llm

        # Unified LLM Provider - shared by all extractors
        # Uses the same LLM endpoint as the rest of the app
        self.llm_provider = LLMProvider(
            provider_type=os.getenv("LLM_PROVIDER", "openai"),
            model=os.getenv("LLM_MODEL") or os.getenv("LOCAL_LLM_MODEL") or "local-model",
            base_url=llm_url,
            api_key=os.getenv("LLM_API_KEY") or os.getenv("LOCAL_LLM_API_KEY") or "not-needed",
            temperature=float(os.getenv("LLM_TEMPERATURE", "0.3")),
            max_tokens=int(os.getenv("LLM_MAX_TOKENS", "8192")),
        )
        logger.info(f"[MemoryManager] Using LLM at: {llm_url}")

        # Episode Extractor - lazy initialization
        self._episode_extractor = None

    # TODO: add username
    async def extract_memcell(
        self,
        history_raw_data_list: list[RawData],
        new_raw_data_list: list[RawData],
        raw_data_type: RawDataType,
        group_id: Optional[str] = None,
        group_name: Optional[str] = None,
        user_id_list: Optional[List[str]] = None,
        old_memory_list: Optional[List[BaseMemory]] = None,
    ) -> tuple[Optional[MemCell], Optional[StatusResult]]:
        """
        Extract MemCell (boundary detection + raw data)

        Args:
            history_raw_data_list: List of historical messages
            new_raw_data_list: List of new messages
            raw_data_type: Data type
            group_id: Group ID
            group_name: Group name
            user_id_list: List of user IDs
            old_memory_list: List of historical memories

        Returns:
            (MemCell, StatusResult) or (None, StatusResult)
        """
        now = time.time()

        # Boundary detection + create MemCell
        logger.debug(
            f"[MemoryManager] Starting boundary detection and creating MemCell"
        )
        request = ConversationMemCellExtractRequest(
            history_raw_data_list,
            new_raw_data_list,
            user_id_list=user_id_list,
            group_id=group_id,
            group_name=group_name,
            old_memory_list=old_memory_list,
        )

        extractor = ConvMemCellExtractor(self.llm_provider)
        memcell, status_result = await extractor.extract_memcell(request)

        if not memcell:
            logger.debug(
                f"[MemoryManager] Boundary detection: no boundary reached, waiting for more messages"
            )
            return None, status_result

        logger.info(
            f"[MemoryManager] ✅ MemCell created successfully: "
            f"event_id={memcell.event_id}, "
            f"elapsed time: {time.time() - now:.2f} seconds"
        )

        return memcell, status_result

    # TODO: add username
    async def extract_memory(
        self,
        memcell: MemCell,
        memory_type: MemoryType,
        user_id: Optional[
            str
        ] = None,  # None means group memory, with value means personal memory
        group_id: Optional[str] = None,
        group_name: Optional[str] = None,
        old_memory_list: Optional[List[BaseMemory]] = None,
        user_organization: Optional[List] = None,
        episode_memory: Optional[
            EpisodeMemory
        ] = None,  # Used for Foresight and EventLog extraction
    ):
        """
        Extract a single memory

        Args:
            memcell: Single MemCell (raw data container for memory)
            memory_type: Memory type
            user_id: User ID
                - None: Extract group Episode/group Profile
                - With value: Extract personal Episode/personal Profile
            group_id: Group ID
            group_name: Group name
            old_memory_list: List of historical memories
            user_organization: User organization information
            episode_memory: Episode memory (used to extract Foresight/EventLog)

        Returns:
            - EPISODIC_MEMORY: Returns Memory (group or personal)
            - FORESIGHT: Returns List[Foresight]
            - PERSONAL_EVENT_LOG: Returns EventLog
            - PROFILE/GROUP_PROFILE: Returns Memory
        """
        # Dispatch based on memory_type enum
        match memory_type:
            case MemoryType.EPISODIC_MEMORY:
                return await self._extract_episode(memcell, user_id, group_id)

            case MemoryType.FORESIGHT:
                return await self._extract_foresight(episode_memory)

            case MemoryType.EVENT_LOG:
                return await self._extract_event_log(episode_memory)

            case MemoryType.PROFILE:
                return await self._extract_profile(
                    memcell, user_id, group_id, old_memory_list
                )

            case MemoryType.GROUP_PROFILE:
                return await self._extract_group_profile(
                    memcell,
                    user_id,
                    group_id,
                    group_name,
                    old_memory_list,
                    user_organization,
                )

            case _:
                logger.warning(f"[MemoryManager] Unknown memory_type: {memory_type}")
                return None
        return None

    async def _extract_episode(
        self, memcell: MemCell, user_id: Optional[str], group_id: Optional[str]
    ) -> Optional[EpisodeMemory]:
        """Extract Episode (group or personal)"""
        if self._episode_extractor is None:
            self._episode_extractor = EpisodeMemoryExtractor(self.llm_provider)

        # Build extraction request
        from services.memory.memory_layer.memory_extractor.base_memory_extractor import MemoryExtractRequest

        request = MemoryExtractRequest(
            memcell=memcell,
            user_id=user_id,  # None=group, with value=personal
            group_id=group_id,
        )

        # Call extractor's extract_memory method
        # It will automatically determine whether to extract group or personal Episode based on user_id
        logger.debug(
            f"[MemoryManager] Extracting {'group' if user_id is None else 'personal'} Episode: user_id={user_id}"
        )

        return await self._episode_extractor.extract_memory(request)

    async def _extract_foresight(
        self, episode_memory: Optional[EpisodeMemory]
    ) -> List[Foresight]:
        """Extract Foresight"""
        if not episode_memory:
            logger.warning(
                "[MemoryManager] Missing episode_memory, cannot extract Foresight"
            )
            return []

        logger.debug(
            f"[MemoryManager] Extracting Foresight for Episode: user_id={episode_memory.user_id}"
        )

        extractor = ForesightExtractor(llm_provider=self.llm_provider)
        return await extractor.generate_foresights_for_episode(episode_memory)

    async def _extract_event_log(self, episode_memory: Optional[EpisodeMemory]):
        """Extract Event Log"""
        if not episode_memory:
            logger.warning(
                "[MemoryManager] Missing episode_memory, cannot extract EventLog"
            )
            return None

        logger.debug(
            f"[MemoryManager] Extracting EventLog for Episode: user_id={episode_memory.user_id}"
        )

        extractor = EventLogExtractor(llm_provider=self.llm_provider)
        return await extractor.extract_event_log(
            episode_text=episode_memory.episode,
            timestamp=episode_memory.timestamp,
            user_id=episode_memory.user_id,
            ori_event_id_list=episode_memory.ori_event_id_list,
            group_id=episode_memory.group_id,
        )

    async def _extract_profile(
        self,
        memcell: MemCell,
        user_id: Optional[str],
        group_id: Optional[str],
        old_memory_list: Optional[List[BaseMemory]],
    ) -> Optional[BaseMemory]:
        """Extract Profile"""
        if memcell.type != RawDataType.CONVERSATION:
            return None

        extractor = ProfileMemoryExtractor(self.llm_provider)
        request = ProfileMemoryExtractRequest(
            memcell_list=[memcell],
            user_id_list=[user_id] if user_id else [],
            group_id=group_id,
            old_memory_list=old_memory_list,
        )
        return await extractor.extract_memory(request)

    async def _extract_group_profile(
        self,
        memcell: MemCell,
        user_id: Optional[str],
        group_id: Optional[str],
        group_name: Optional[str],
        old_memory_list: Optional[List[BaseMemory]],
        user_organization: Optional[List],
    ) -> Optional[BaseMemory]:
        """Extract Group Profile"""
        extractor = GroupProfileMemoryExtractor(self.llm_provider)
        request = GroupProfileMemoryExtractRequest(
            memcell_list=[memcell],
            user_id_list=[user_id] if user_id else [],
            group_id=group_id,
            group_name=group_name,
            old_memory_list=old_memory_list,
            user_organization=user_organization,
        )
        return await extractor.extract_memory(request)
