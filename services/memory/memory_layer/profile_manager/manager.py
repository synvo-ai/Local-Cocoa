"""ProfileManager - Pure computation component for profile extraction.

This module provides pure computation logic for extracting user profiles
from memcells. Storage is managed by the caller, not by ProfileManager itself.

Design:
- ProfileManager is a pure computation component
- Input: memcells + old_profiles
- Output: new_profiles
- Caller is responsible for loading/saving profiles
"""

import asyncio
from typing import Any, Dict, List, Optional
from pathlib import Path

from services.memory.memory_layer.llm.llm_provider import LLMProvider
from services.memory.memory_layer.memory_extractor.profile_memory_extractor import (
    ProfileMemoryExtractor,
    ProfileMemoryExtractRequest,
)
from services.memory.memory_layer.profile_manager.config import ProfileManagerConfig, ScenarioType
from services.memory.core.observation.logger import get_logger

logger = get_logger(__name__)


class ProfileManager:
    """Pure computation component for profile extraction.
    
    ProfileManager extracts user profiles from memcells using LLM.
    It does NOT handle storage - the caller is responsible for loading
    old profiles and saving new profiles.
    
    Usage:
        ```python
        profile_mgr = ProfileManager(llm_provider, config)
        
        # Caller loads old profiles
        old_profiles = await storage.get_all_profiles()
        
        # Pure computation - extract profiles
        new_profiles = await profile_mgr.extract_profiles(
            memcells=memcell_list,
            old_profiles=list(old_profiles.values()),
            user_id_list=["user1", "user2"],
        )
        
        # Caller saves new profiles
        for profile in new_profiles:
            await storage.save_profile(profile.user_id, profile)
        ```
    """
    
    def __init__(
        self,
        llm_provider: LLMProvider,
        config: Optional[ProfileManagerConfig] = None,
        group_id: Optional[str] = None,
        group_name: Optional[str] = None,
    ):
        """Initialize ProfileManager.
        
        Args:
            llm_provider: LLM provider for profile extraction
            config: Manager configuration (uses defaults if None)
            group_id: Group/conversation identifier
            group_name: Group/conversation name
        """
        self.llm_provider = llm_provider
        self.config = config or ProfileManagerConfig()
        self.group_id = group_id or "default"
        self.group_name = group_name
        
        # Initialize profile extractor
        self._profile_extractor = ProfileMemoryExtractor(llm_provider=llm_provider)
        
        # Statistics
        self._stats = {
            "total_extractions": 0,
            "successful_extractions": 0,
            "failed_extractions": 0,
        }
    
    async def extract_profiles(
        self,
        memcells: List[Any],
        old_profiles: Optional[List[Any]] = None,
        user_id_list: Optional[List[str]] = None,
        group_id: Optional[str] = None,
        group_name: Optional[str] = None,
    ) -> List[Any]:
        """Extract profiles from memcells - pure computation.
        
        This method performs profile extraction without any storage operations.
        The caller is responsible for loading old profiles and saving new profiles.
        
        Args:
            memcells: List of memcells to extract profiles from
            old_profiles: Existing profiles for incremental merging (optional)
            user_id_list: List of user IDs to extract profiles for (optional)
            group_id: Override group_id (optional, uses instance default)
            group_name: Override group_name (optional, uses instance default)
        
        Returns:
            List of extracted ProfileMemory objects
        """
        self._stats["total_extractions"] += 1
        
        if not memcells:
            logger.warning("No memcells provided for profile extraction")
            return []
        
        # Use provided or instance values
        gid = group_id or self.group_id
        gname = group_name or self.group_name
        
        # Limit batch size
        if len(memcells) > self.config.batch_size:
            logger.warning(
                f"Got {len(memcells)} memcells, limiting to {self.config.batch_size} most recent"
            )
            memcells = memcells[-self.config.batch_size:]
        
        # Build extraction request
        request = ProfileMemoryExtractRequest(
            memcell_list=memcells,
            user_id_list=user_id_list or [],
            group_id=gid,
            group_name=gname,
            old_memory_list=old_profiles if old_profiles else None,
        )
        
        # Extract profiles with retry logic
        for attempt in range(self.config.max_retries):
            try:
                logger.info(f"Extracting profiles (scenario: {self.config.scenario.value})...")
                
                if self.config.scenario == ScenarioType.ASSISTANT:
                    result = await self._profile_extractor.extract_profile_companion(request)
                else:
                    result = await self._profile_extractor.extract_memory(request)
                
                if not result:
                    logger.warning("Profile extraction returned empty result")
                    return []
                
                self._stats["successful_extractions"] += 1
                logger.info(f"Extracted {len(result)} profiles")
                
                return result
            
            except Exception as e:
                logger.warning(f"Profile extraction attempt {attempt + 1}/{self.config.max_retries} failed: {e}")
                if attempt < self.config.max_retries - 1:
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    self._stats["failed_extractions"] += 1
                    logger.error("All profile extraction attempts failed")
                    raise
        
        return []
    
    def get_stats(self) -> Dict[str, Any]:
        """Get extraction statistics."""
        return dict(self._stats)
