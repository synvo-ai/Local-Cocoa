"""
Pydantic models for Memory API requests and responses
"""

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime
from enum import Enum


class MemoryTypeEnum(str, Enum):
    """Memory type enumeration for API"""
    EPISODIC = "episodic_memory"
    PROFILE = "profile"
    FORESIGHT = "foresight"
    EVENT_LOG = "event_log"
    GROUP_PROFILE = "group_profile"
    CORE = "core"


class RetrieveMethodEnum(str, Enum):
    """Retrieval method enumeration"""
    KEYWORD = "keyword"
    VECTOR = "vector"
    HYBRID = "hybrid"
    RRF = "rrf"
    AGENTIC = "agentic"


# ==================== Request Models ====================

class RawDataItem(BaseModel):
    """Raw data item for memorization"""
    content: Dict[str, Any]
    data_id: str
    data_type: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MemorizeRequest(BaseModel):
    """Request to process and memorize new data"""
    raw_data_list: List[RawDataItem]
    user_id: str
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    enable_foresight: bool = True
    enable_event_log: bool = True


class SearchMemoryRequest(BaseModel):
    """Request to search memories"""
    query: str
    user_id: str
    method: RetrieveMethodEnum = RetrieveMethodEnum.RRF
    memory_types: Optional[List[MemoryTypeEnum]] = None
    limit: int = Field(default=20, ge=1, le=100)


class GetMemoriesRequest(BaseModel):
    """Request to get user memories"""
    user_id: str
    memory_type: Optional[MemoryTypeEnum] = None
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


# ==================== Response Models ====================

class MemoryRecord(BaseModel):
    """Generic memory record"""
    id: str
    user_id: str
    memory_type: str
    content: str
    summary: Optional[str] = None
    timestamp: datetime
    metadata: Optional[Dict[str, Any]] = None
    score: Optional[float] = None  # For search results


class EpisodeRecord(BaseModel):
    """Episodic memory record"""
    id: str
    user_id: str
    title: Optional[str] = None
    summary: str
    episode: Optional[str] = None
    timestamp: datetime
    participants: List[str] = []
    subject: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ProfileRecord(BaseModel):
    """User profile record"""
    user_id: str
    user_name: Optional[str] = None
    personality: Optional[List[str]] = None
    hard_skills: Optional[List[Dict[str, str]]] = None
    soft_skills: Optional[List[Dict[str, str]]] = None
    interests: Optional[List[str]] = None
    motivation_system: Optional[List[Dict[str, Any]]] = None
    value_system: Optional[List[Dict[str, Any]]] = None
    projects_participated: Optional[List[Dict[str, str]]] = None
    updated_at: Optional[datetime] = None


class ForesightRecord(BaseModel):
    """Foresight/prospective memory record"""
    id: str
    user_id: str
    content: str
    evidence: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    duration_days: Optional[int] = None
    parent_episode_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class EventLogRecord(BaseModel):
    """Event log (atomic fact) record"""
    id: str
    user_id: str
    atomic_fact: str
    timestamp: datetime
    parent_episode_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MemorizeResult(BaseModel):
    """Result of memorization process"""
    success: bool
    message: str
    episodes_created: int = 0
    event_logs_created: int = 0
    foresights_created: int = 0
    profile_updated: bool = False


class SearchMemoryResult(BaseModel):
    """Result of memory search"""
    memories: List[MemoryRecord]
    total_count: int
    query: str
    method: str


class UserMemorySummary(BaseModel):
    """Summary of user's memories"""
    user_id: str
    profile: Optional[ProfileRecord] = None
    episodes_count: int = 0
    event_logs_count: int = 0
    foresights_count: int = 0
    recent_episodes: List[EpisodeRecord] = []
    recent_foresights: List[ForesightRecord] = []
