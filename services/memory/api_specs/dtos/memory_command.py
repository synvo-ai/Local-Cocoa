from dataclasses import dataclass
import datetime
from typing import List, Optional

from dataclasses import dataclass
from typing import List, Dict, Any, Optional
from datetime import datetime
import json
from services.memory.api_specs.memory_types import RawDataType
import re

from bson import ObjectId


iso_pattern = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'


@dataclass
class RawData:  # Memcell this is actually more oriented towards input, this is at a higher level of input; the one in the memcell table is the storage structure, which is more low-level
    """Raw data structure for storing original content."""

    content: dict[str, Any]
    data_id: str
    data_type: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    def _serialize_value(self, value: Any) -> Any:
        """
        Recursively serialize values, handling special types like datetime and ObjectId

        Args:
            value: Value to be serialized

        Returns:
            JSON-serializable value
        """
        if isinstance(value, datetime):
            return value.isoformat()
        elif isinstance(value, ObjectId):
            # Serialize ObjectId to string
            return str(value)
        elif isinstance(value, dict):
            return {k: self._serialize_value(v) for k, v in value.items()}
        elif isinstance(value, (list, tuple)):
            return [self._serialize_value(item) for item in value]
        elif hasattr(value, '__dict__'):
            # Handle custom objects by converting to dictionary
            return self._serialize_value(value.__dict__)
        else:
            return value

    def _deserialize_value(self, value: Any, field_name: str = "") -> Any:
        """
        Recursively deserialize values, heuristically determining whether to restore datetime type based on field name

        Args:
            value: Value to be deserialized
            field_name: Field name, used for heuristic judgment

        Returns:
            Deserialized value
        """
        if isinstance(value, str):
            # Heuristically determine if it's a datetime field based on field name
            if self._is_datetime_field(field_name) and self._is_iso_datetime(value):
                try:
                    from services.memory.common_utils.datetime_utils import from_iso_format

                    return from_iso_format(value)
                except (ValueError, ImportError):
                    return value
            return value
        elif isinstance(value, dict):
            return {k: self._deserialize_value(v, k) for k, v in value.items()}
        elif isinstance(value, list):
            return [self._deserialize_value(item, field_name) for item in value]
        else:
            return value

    def _is_datetime_field(self, field_name: str) -> bool:
        """
        Heuristically determine if a field is a datetime field based on its name

        Args:
            field_name: Field name

        Returns:
            bool: Whether the field is a datetime field
        """
        if not isinstance(field_name, str):
            return False

        # Exact match datetime field names (based on actual field names used in the project)
        exact_datetime_fields = {
            'timestamp',
            'createTime',
            'updateTime',
            'create_time',
            'update_time',
            'sent_timestamp',
            'received_timestamp',
            'create_timestamp',
            'last_update_timestamp',
            'modify_timestamp',
            'created_at',
            'updated_at',
            'joinTime',
            'leaveTime',
            'lastOnlineTime',
            'sync_time',
            'processed_at',
            'start_time',
            'end_time',
            'event_time',
            'build_timestamp',
            'datetime',
            'created',
            'updated',  # Add common datetime field variants
        }

        field_lower = field_name.lower()

        # Exact match check
        if field_name in exact_datetime_fields or field_lower in exact_datetime_fields:
            return True

        # Exclude common words that should not be recognized as datetime fields
        exclusions = {
            'runtime',
            'timeout',
            'timeline',
            'timestamp_format',
            'time_zone',
            'time_limit',
            'timestamp_count',
            'timestamp_enabled',
            'time_sync',
            'playtime',
            'lifetime',
            'uptime',
            'downtime',
        }

        if field_name in exclusions or field_lower in exclusions:
            return False

        # Suffix match check (stricter rules)
        time_suffixes = ['_time', '_timestamp', '_at', '_date']
        for suffix in time_suffixes:
            if field_name.endswith(suffix) or field_lower.endswith(suffix):
                return True

        # Prefix match check (stricter rules)
        if field_name.endswith('Time') and not field_name.endswith('runtime'):
            # Match xxxTime pattern, but exclude runtime
            return True

        if field_name.endswith('Timestamp'):
            # Match xxxTimestamp pattern
            return True

        return False

    def _is_iso_datetime(self, value: str) -> bool:
        """
        Check if string is ISO format datetime

        Args:
            value: String value

        Returns:
            bool: Whether it is ISO datetime format
        """
        # Simple ISO datetime format check
        if not isinstance(value, str) or len(value) < 19:
            return False

        # Check basic ISO format pattern: YYYY-MM-DDTHH:MM:SS
        return bool(re.match(iso_pattern, value))

    def to_json(self) -> str:
        """
        Serialize RawData object to JSON string

        Returns:
            str: JSON string
        """
        try:
            data = {
                'content': self._serialize_value(self.content),
                'data_id': self.data_id,
                'data_type': self.data_type,
                'metadata': (
                    self._serialize_value(self.metadata) if self.metadata else None
                ),
            }
            return json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        except (TypeError, ValueError) as e:
            raise ValueError(f"Failed to serialize RawData to JSON: {e}") from e

    @classmethod
    def from_json_str(cls, json_str: str) -> 'RawData':
        """
        Deserialize RawData object from JSON string

        Args:
            json_str: JSON string

        Returns:
            RawData: Deserialized RawData object

        Raises:
            ValueError: JSON format error or missing required fields
        """
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON format error: {e}") from e

        if not isinstance(data, dict):
            raise ValueError("JSON must be an object")

        # Check required fields
        if 'content' not in data or 'data_id' not in data:
            raise ValueError("JSON missing required fields: content and data_id")

        # Create instance and deserialize values
        instance = cls.__new__(cls)
        instance.content = instance._deserialize_value(data['content'], 'content')
        instance.data_id = data['data_id']
        instance.data_type = data.get('data_type')
        instance.metadata = (
            instance._deserialize_value(data.get('metadata'), 'metadata')
            if data.get('metadata')
            else None
        )

        return instance


@dataclass
class MemorizeRequest:
    history_raw_data_list: list[RawData]
    new_raw_data_list: list[RawData]
    raw_data_type: RawDataType
    # Full list of user_id for the entire group
    user_id_list: List[str]
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    current_time: Optional[datetime] = None
    # Optional extraction control parameters
    enable_foresight_extraction: bool = True  # Whether to extract foresight
    enable_event_log_extraction: bool = True  # Whether to extract event logs
