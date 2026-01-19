"""Utilities for merging profile memories collected from multiple groups."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

from services.memory.core.observation.logger import get_logger

from services.memory.memory_layer.llm.llm_provider import LLMProvider
from services.memory.memory_layer.memory_extractor.profile_memory.data_normalize import merge_single_profile, project_to_dict
from services.memory.memory_layer.memory_extractor.profile_memory.project_helpers import merge_projects_participated
from services.memory.memory_layer.memory_extractor.profile_memory.skill_helpers import merge_skill_lists_keep_highest_level
from services.memory.memory_layer.memory_extractor.profile_memory.types import (
    ProfileMemory,
    ImportanceEvidence,
)
from services.memory.memory_layer.memory_extractor.profile_memory.value_helpers import (
    merge_value_with_evidences_lists,
    merge_value_with_evidences_lists_keep_highest_level,
)

logger = get_logger(__name__)


def convert_important_info_to_evidence(
    important_info: Dict[str, Any]
) -> List[ImportanceEvidence]:
    """Convert aggregated group stats into ImportanceEvidence instances."""
    evidence_list: List[ImportanceEvidence] = []
    total_msgs = important_info["group_data"]["total_messages"]
    for user_id, user_data in important_info["user_data"].items():
        evidence_list.append(
            ImportanceEvidence(
                user_id=user_id,
                group_id=important_info["group_id"],
                speak_count=user_data["chat_count"],
                refer_count=user_data["at_count"],
                conversation_count=total_msgs,
            )
        )
    return evidence_list


class ProfileMemoryMerger:
    """Merge multiple ProfileMemory instances for a single user ."""

    def __init__(self, llm_provider: LLMProvider) -> None:
        if llm_provider is None:
            error_msg = "llm_provider must not be None"
            logger.exception(error_msg)
            raise ValueError(error_msg)
        self.llm_provider = llm_provider

    @staticmethod
    def _truncate_evidences(evidences: Iterable[Any]) -> List[str]:
        if not evidences:
            return []
        normalized = [str(item).strip() for item in evidences if item]
        normalized = [item for item in normalized if item]
        if len(normalized) <= 10:
            return normalized

        def parse_date(prefix: str) -> Optional[datetime]:
            if not prefix:
                return None
            try:
                return datetime.fromisoformat(prefix)
            except ValueError:
                try:
                    return datetime.strptime(prefix, "%Y-%m-%d")
                except ValueError:
                    return None

        records: List[Dict[str, Any]] = []
        for idx, entry in enumerate(normalized):
            date_value: Optional[datetime] = None
            has_date = False
            if "|" in entry:
                prefix = entry.split("|", 1)[0].strip()
                parsed = parse_date(prefix)
                if parsed is not None:
                    has_date = True
                    date_value = parsed
            records.append(
                {"entry": entry, "index": idx, "has_date": has_date, "date": date_value}
            )

        # Truncate to 10 entries if needed: prefer dated entries (most recent first), then undated
        if len(records) > 10:
            dated = [r for r in records if r["has_date"]]
            undated = [r for r in records if not r["has_date"]]
            # Sort dated by date descending (most recent first)
            dated.sort(key=lambda r: r["date"] or "", reverse=True)
            # Take up to 10 dated, fill remaining with undated
            selected = dated[:10]
            if len(selected) < 10:
                selected.extend(undated[: 10 - len(selected)])
            records = selected

        return [record["entry"] for record in records]

    @classmethod
    def _profile_memory_to_prompt_dict(cls, profile: ProfileMemory) -> Dict[str, Any]:

        def truncate_evidences_in_items(
            items: Optional[List[Dict[str, Any]]]
        ) -> List[Dict[str, Any]]:
            if not items:
                return []
            result = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_copy = item.copy()
                evidences = item_copy.get("evidences", [])
                if evidences:
                    item_copy["evidences"] = cls._truncate_evidences(evidences)
                result.append(item_copy)
            return result

        return {
            "group_id": profile.group_id or "",
            "user_id": profile.user_id,
            "user_name": profile.user_name or "",
            "user_goal": truncate_evidences_in_items(profile.user_goal),
            "working_habit_preference": truncate_evidences_in_items(
                profile.working_habit_preference
            ),
            "interests": truncate_evidences_in_items(profile.interests),
            "hard_skills": truncate_evidences_in_items(profile.hard_skills),
            "soft_skills": truncate_evidences_in_items(profile.soft_skills),
            "personality": truncate_evidences_in_items(profile.personality),
            "way_of_decision_making": truncate_evidences_in_items(
                profile.way_of_decision_making
            ),
            "work_responsibility": truncate_evidences_in_items(
                profile.work_responsibility
            ),
            "tendency": truncate_evidences_in_items(profile.tendency),
            "projects_participated": [
                project_to_dict(project)
                for project in profile.projects_participated or []
            ],
        }

    async def merge_group_profiles(
        self, group_profiles: List[ProfileMemory], user_id: str
    ) -> ProfileMemory:
        """
        Merge multiple ProfileMemory instances from different groups for a single user.

        Strategy:
        - For fields with 'level' attribute (hard_skills, soft_skills, motivation_system,
          fear_system, value_system, humor_use, colloquialism): keep the highest level
        - For other fields (way_of_decision_making, personality, user_goal, etc.):
          merge evidences normally
        - Filter out profiles where group_importance_evidence.is_important is False
          (except for projects_participated which uses all profiles)
        """
        if not group_profiles:
            error_msg = "group_profiles must not be empty when merging"
            logger.exception(error_msg)
            raise ValueError(error_msg)

        # Build both lists in a single loop
        all_matching_profiles: List[ProfileMemory] = []
        important_profiles: List[ProfileMemory] = []

        for profile in group_profiles:
            if profile is not None and profile.user_id == user_id:
                all_matching_profiles.append(profile)
                # Filter profiles for most fields (exclude is_important=False)
                if (
                    profile.group_importance_evidence is None
                    or profile.group_importance_evidence.is_important is True
                ):
                    important_profiles.append(profile)

        if not all_matching_profiles:
            error_msg = f"No ProfileMemory found for user_id '{user_id}' when merging"
            logger.exception(error_msg)
            raise ValueError(error_msg)

        # Use important_profiles if available, otherwise fall back to all profiles
        matching_profiles = (
            important_profiles if important_profiles else all_matching_profiles
        )

        # Extract all profiles' data for merging
        base_profile = matching_profiles[0]

        # Fields with level - use keep_highest_level strategy
        merged_hard_skills = merge_skill_lists_keep_highest_level(
            *[p.hard_skills for p in matching_profiles]
        )
        merged_soft_skills = merge_skill_lists_keep_highest_level(
            *[p.soft_skills for p in matching_profiles]
        )
        merged_motivation_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.motivation_system for p in matching_profiles]
        )
        merged_fear_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.fear_system for p in matching_profiles]
        )
        merged_value_system = merge_value_with_evidences_lists_keep_highest_level(
            *[p.value_system for p in matching_profiles]
        )
        merged_humor_use = merge_value_with_evidences_lists_keep_highest_level(
            *[p.humor_use for p in matching_profiles]
        )
        merged_colloquialism = merge_value_with_evidences_lists_keep_highest_level(
            *[p.colloquialism for p in matching_profiles]
        )

        # Fields without level - use normal merge strategy
        def merge_field_normal(field_name: str) -> Optional[List[Dict[str, Any]]]:
            """Merge a field across all profiles using normal strategy."""
            result = None
            for profile in matching_profiles:
                field_value = getattr(profile, field_name, None)
                result = merge_value_with_evidences_lists(result, field_value)
            return result

        merged_way_of_decision_making = merge_field_normal("way_of_decision_making")
        merged_personality = merge_field_normal("personality")
        merged_user_goal = merge_field_normal("user_goal")
        merged_work_responsibility = merge_field_normal("work_responsibility")
        merged_working_habit_preference = merge_field_normal("working_habit_preference")
        merged_interests = merge_field_normal("interests")
        merged_tendency = merge_field_normal("tendency")

        # Merge projects - use ALL matching profiles (not filtered by is_important)
        merged_projects = None
        for profile in all_matching_profiles:
            merged_projects = merge_projects_participated(
                merged_projects, profile.projects_participated
            )

        # Merge reasoning_parts fields
        reasoning_parts: List[str] = []
        for profile in matching_profiles:
            text = profile.output_reasoning
            if text:
                stripped = text.strip()
                if stripped:
                    reasoning_parts.append(stripped)
        output_reasoning = "$".join(reasoning_parts) if reasoning_parts else None

        user_name = None
        for profile in reversed(matching_profiles):
            if profile.user_name:
                user_name = profile.user_name
                break

        # Collect all group_ids
        group_ids = [p.group_id for p in matching_profiles if p.group_id]
        merged_group_id = (
            ",".join(group_ids) if group_ids else base_profile.group_id or ""
        )

        # Get the most recent timestamp and ori_event_id_list
        timestamp = base_profile.timestamp
        ori_event_id_list = base_profile.ori_event_id_list
        for profile in matching_profiles[1:]:
            if profile.timestamp:
                timestamp = profile.timestamp
            if profile.ori_event_id_list:
                ori_event_id_list = profile.ori_event_id_list

        return ProfileMemory(
            memory_type=base_profile.memory_type,
            user_id=user_id,
            timestamp=timestamp,
            ori_event_id_list=ori_event_id_list,
            user_name=user_name,
            group_id=merged_group_id,
            hard_skills=merged_hard_skills,
            soft_skills=merged_soft_skills,
            output_reasoning=output_reasoning,
            motivation_system=merged_motivation_system,
            fear_system=merged_fear_system,
            value_system=merged_value_system,
            humor_use=merged_humor_use,
            colloquialism=merged_colloquialism,
            way_of_decision_making=merged_way_of_decision_making,
            personality=merged_personality,
            projects_participated=merged_projects,
            user_goal=merged_user_goal,
            work_responsibility=merged_work_responsibility,
            working_habit_preference=merged_working_habit_preference,
            interests=merged_interests,
            tendency=merged_tendency,
        )
