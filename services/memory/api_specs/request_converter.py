"""
Request converter module

This module contains various functions to convert external request formats to internal Request objects.
"""

from __future__ import annotations

from typing import Any, Dict, List, Union, Optional
from datetime import datetime
from zoneinfo import ZoneInfo

from services.memory.api_specs.memory_models import MemoryType
from services.memory.api_specs.dtos.memory_query import RetrieveMemRequest, FetchMemRequest
from services.memory.api_specs.dtos.memory_command import MemorizeRequest
from services.memory.api_specs.memory_types import RawDataType
from services.memory.api_specs.dtos.memory_command import RawData

from typing import Dict, Any, Optional
from services.memory.common_utils.datetime_utils import from_iso_format
from zoneinfo import ZoneInfo
from services.memory.core.observation.logger import get_logger
from services.memory.api_specs.memory_models import RetrieveMethod, MemoryType
logger = get_logger(__name__)


class DataFields:
    """Data field constants"""

    MESSAGES = "messages"
    RAW_DATA_TYPE = "raw_data_type"
    GROUP_ID = "group_id"


def convert_dict_to_fetch_mem_request(data: Dict[str, Any]) -> FetchMemRequest:
    """
    Convert dictionary to FetchMemRequest object

    Args:
        data: Dictionary containing FetchMemRequest fields

    Returns:
        FetchMemRequest object

    Raises:
        ValueError: When required fields are missing or have incorrect types
    """
    try:
        # Validate required fields
        if "user_id" not in data:
            raise ValueError("user_id is a required field")

        # Convert memory_type, use default if not provided
        memory_type = MemoryType(data.get("memory_type", "multiple"))
        logger.debug(f"version_range: {data.get('version_range', None)}")

        # Convert limit and offset to integer type (all obtained from query_params are strings)
        limit = data.get("limit", 10)
        offset = data.get("offset", 0)
        if isinstance(limit, str):
            limit = int(limit)
        if isinstance(offset, str):
            offset = int(offset)

        # Build FetchMemRequest object
        return FetchMemRequest(
            user_id=data["user_id"],
            memory_type=memory_type,
            limit=limit,
            offset=offset,
            filters=data.get("filters", {}),
            sort_by=data.get("sort_by"),
            sort_order=data.get("sort_order", "desc"),
            version_range=data.get("version_range", None),
        )
    except Exception as e:
        raise ValueError(f"FetchMemRequest conversion failed: {e}")


def convert_dict_to_retrieve_mem_request(
    data: Dict[str, Any], query: Optional[str] = None
) -> RetrieveMemRequest:
    """
    Convert dictionary to RetrieveMemRequest object

    Args:
        data: Dictionary containing RetrieveMemRequest fields
        query: Query text (optional)

    Returns:
        RetrieveMemRequest object

    Raises:
        ValueError: When required fields are missing or have incorrect types
    """
    try:
        # Handle retrieve_method, use default keyword if not provided

        retrieve_method_str = data.get("retrieve_method", "keyword")
        logger.debug(f"[DEBUG] retrieve_method_str from data: {retrieve_method_str!r}")

        # Convert string to RetrieveMethod enum
        try:
            retrieve_method = RetrieveMethod(retrieve_method_str)
            logger.debug(f"[DEBUG] converted to: {retrieve_method}")
        except ValueError:
            raise ValueError(
                f"Invalid retrieve_method: {retrieve_method_str}. "
                f"Supported methods: {[m.value for m in RetrieveMethod]}"
            )

        # Convert top_k to integer type (all obtained from query_params are strings)
        top_k = data.get("top_k", 10)
        if isinstance(top_k, str):
            top_k = int(top_k)

        # Convert include_metadata to boolean type
        include_metadata = data.get("include_metadata", True)
        if isinstance(include_metadata, str):
            include_metadata = include_metadata.lower() in ("true", "1", "yes")

        # Convert radius to float type (if exists)
        radius = data.get("radius", None)
        if radius is not None and isinstance(radius, str):
            radius = float(radius)

        # Convert memory_types string list to MemoryType enum list
        raw_memory_types = data.get("memory_types", [])
        # Handle comma-separated string (from query_params)
        if isinstance(raw_memory_types, str):
            raw_memory_types = [mt.strip() for mt in raw_memory_types.split(",") if mt.strip()]
        memory_types = []
        for mt in raw_memory_types:
            if isinstance(mt, str):
                try:
                    memory_types.append(MemoryType(mt))
                except ValueError:
                    logger.error(f"Invalid memory_type: {mt}, skipping")
            elif isinstance(mt, MemoryType):
                memory_types.append(mt)
        # Default to EPISODIC_MEMORY if empty
        if not memory_types:
            memory_types = [MemoryType.EPISODIC_MEMORY]

        return RetrieveMemRequest(
            retrieve_method=retrieve_method,
            user_id=data.get("user_id", None),
            group_id=data.get("group_id", None),  # Group ID
            query=query or data.get("query", None),
            memory_types=memory_types,
            top_k=top_k,
            filters=data.get("filters", {}),
            include_metadata=include_metadata,
            start_time=data.get("start_time", None),
            end_time=data.get("end_time", None),
            radius=radius,  # COSINE similarity threshold
        )
    except Exception as e:
        raise ValueError(f"RetrieveMemRequest conversion failed: {e}")


# =========================================


def _extract_current_time(data: Dict[str, Any]) -> Optional[datetime]:
    """
    Extract current_time field from data

    Args:
        data: Data dictionary

    Returns:
        current_time or None
    """
    if "current_time" not in data:
        return None

    current_time_str = data["current_time"]
    if isinstance(current_time_str, str):
        try:
            return datetime.fromisoformat(current_time_str.replace('Z', '+00:00'))
        except ValueError:
            logger.warning(f"Unable to parse current_time: {current_time_str}")
            return None
    elif isinstance(current_time_str, datetime):
        # from anhua
        if current_time_str.tzinfo is None:
            return current_time_str.replace(tzinfo=ZoneInfo("UTC"))
        return current_time_str

    return None


def _create_memorize_request(
    history_data: List[RawData],
    new_data: List[RawData],
    data_type: RawDataType,
    participants: List[str],
    group_id: str = None,
    group_name: str = None,
    current_time: datetime = None,
) -> MemorizeRequest:
    """
    Common function to create MemorizeRequest object

    Args:
        history_data: List of historical data
        new_data: List of new data
        data_type: Data type
        participants: List of participants
        group_id: Group ID
        group_name: Group name
        current_time: Current time

    Returns:
        MemorizeRequest object
    """
    # Ensure participants is not None
    if participants is None:
        participants = []

    # If current_time is None, try to get it from timestamp or updateTime of new_data[0]
    if current_time is None and new_data and new_data[0] is not None:
        first_data = new_data[0]
        if hasattr(first_data, 'content') and first_data.content:
            # Prefer updateTime
            if 'updateTime' in first_data.content and first_data.content['updateTime']:
                current_time = first_data.content['updateTime']
            elif 'timestamp' in first_data.content and first_data.content['timestamp']:
                current_time = first_data.content['timestamp']

    return MemorizeRequest(
        history_raw_data_list=history_data,
        new_raw_data_list=new_data,
        raw_data_type=data_type,
        user_id_list=participants,
        group_id=group_id,
        group_name=group_name,
        current_time=current_time,
    )


async def convert_single_message_to_raw_data(
    input_data: Dict[str, Any],
    data_id_field: str = "_id",
    group_name: Optional[str] = None,
) -> RawData:
    """
    Convert input data to RawData format

    Args:
        input_data: Dictionary containing _id, fullName, receiverId, roomId, userIdList,
                   referList, content, createTime, createBy, updateTime, orgId
        data_id_field: Field name used as data_id, default is "_id"
        group_name: Group name (passed from outside, will be added to message content)

    Returns:
        RawData object
    """
    # Extract data_id
    data_id = str(input_data.get(data_id_field, ""))

    room_id = input_data.get("roomId")

    # group_name fully depends on external input
    # If not passed externally, it will be None (no longer query database)
    if group_name:
        logger.debug("Using externally provided group_name: %s", group_name)
    else:
        logger.debug("No external group_name provided, will use None")

    # Build content dictionary, including all business-related fields
    content = {
        "speaker_name": input_data.get("fullName"),
        "receiverId": input_data.get("receiverId"),
        "roomId": room_id,
        "groupName": group_name,  # Add group name
        "userIdList": input_data.get("userIdList", []),
        "referList": input_data.get("referList", []),
        "content": input_data.get("content"),
        "timestamp": from_iso_format(
            input_data.get("createTime"), ZoneInfo("UTC")
        ),  # Use converted UTC time
        "createBy": input_data.get("createBy"),
        "updateTime": from_iso_format(
            input_data.get("updateTime"), ZoneInfo("UTC")
        ),  # Use converted UTC time
        "orgId": input_data.get("orgId"),
        "speaker_id": input_data.get("createBy"),
        "msgType": input_data.get("msgType"),
        "data_id": data_id,
    }

    # Build metadata, including system fields
    metadata = {
        "original_id": data_id,
        "createTime": from_iso_format(
            input_data.get("createTime"), ZoneInfo("UTC")
        ),  # Use converted UTC time
        "updateTime": from_iso_format(
            input_data.get("updateTime"), ZoneInfo("UTC")
        ),  # Use converted UTC time
        "createBy": input_data.get("createBy"),
        "orgId": input_data.get("orgId"),
    }

    return RawData(content=content, data_id=data_id, metadata=metadata)


async def convert_conversation_to_raw_data_list(
    input_data_list: list[Dict[str, Any]],
    data_id_field: str = "_id",
    group_name: Optional[str] = None,
) -> list[RawData]:
    """
    Batch convert data to RawData format

    Args:
        input_data_list: List of input data
        data_id_field: Field name used as data_id, default is "_id"
        group_name: Group name (passed from outside, will be passed to each message conversion)

    Returns:
        List of RawData objects
    """
    return [
        await convert_single_message_to_raw_data(
            data, data_id_field=data_id_field, group_name=group_name
        )
        for data in input_data_list
    ]


async def handle_conversation_format(data: Dict[str, Any]) -> MemorizeRequest:
    """
    Handle chat message format data

    Args:
        data: Data containing messages field

    Returns:
        MemorizeRequest object
    """
    logger.debug("Handling chat message format data")
    messages = data.get(DataFields.MESSAGES, [])
    if not messages:
        raise ValueError("messages field cannot be empty")

    # Extract group-level information
    group_name = data.get("group_name")

    # Convert to RawData format, passing group name
    raw_data_list = await convert_conversation_to_raw_data_list(
        messages, group_name=group_name
    )

    # Extract current_time
    current_time = _extract_current_time(data)

    return _create_memorize_request(
        history_data=[],
        new_data=raw_data_list,
        data_type=RawDataType(data.get(DataFields.RAW_DATA_TYPE, "Conversation")),
        participants=[],
        group_id=data.get(DataFields.GROUP_ID),
        group_name=data.get("group_name"),
        current_time=current_time,
    )
