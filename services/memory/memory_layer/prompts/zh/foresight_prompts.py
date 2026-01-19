"""
前瞻联想预测提示词模板

用于生成基于MemCell和EpisodeMemory内容的前瞻联想预测
"""

GROUP_FORESIGHT_GENERATION_PROMPT = """
你是一个高级语义分析智能体，你的任务是基于群组最近的MemCell事件，联想预测该事件可能引发的后续群体行为、氛围变化和成员互动趋势。

## 任务目标：
1. **联想预测而非总结**：基于事件内容，联想可能发生的后续群体变化，而不是重复或总结原文内容。
2. **场景风格匹配**：预测内容必须符合事件发生的场景风格：
   - 生活场景（如朋友聚会、日常活动）→ 使用生活化用词，关注情感交流、日常安排、休闲娱乐、相互关怀等
   - 工作场景（如会议、项目、商务）→ 使用工作化用词，关注任务推进、决策制定、效率提升、目标达成等
3. **群体层面分析**：从群组整体角度分析事件对群体行为、氛围、协作模式可能产生的影响。
4. **时间维度合理**：每条预测应包含合理的时间维度，结合事件类型和常识推断持续时间。
5. **具体可操作**：每条预测不超过40字，必须生成恰好10条，内容具体且可验证。
6. **成员关系导向**：允许引用具体成员ID（如user_1、user_2），但重点描述"群体关系变化"或"整体氛围走向"。
7. **语义关联性**：联想内容应与原事件保持语义关联，通过evidence字段存储原始事实，确保能追溯事件来源。

## 输出格式：
以JSON数组返回结果，每个联想包含时间信息和证据：
[
  {
    "content": "未来一周团队沟通频率将提升",
    "evidence": "会议中user_1强调了沟通效率问题",
    "start_time": "2025-01-15",
    "end_time": "2025-01-22",
    "duration_days": 7,
    "parent_episode_id": "group-2025-001"
  }
  ...
]

## 示例输入（工作场景）：
{
  "event_id": "group-2025-001",
  "group_id": "group_001",
  "user_id_list": ["user_1", "user_2", "user_3"],
  "summary": "团队完成了阶段性项目复盘会议，讨论了任务分配和未来方向。",
  "episode": "会议中，user_1强调了沟通效率问题，user_2提出新的目标方向，user_3表达了工作负荷压力。总体气氛积极，但存在分歧。"
}

## 示例输出（工作场景）：
[
  {
    "content": "团队会增加小组讨论的频率",
    "evidence": "会议中存在分歧但气氛积极",
    "start_time": "2025-01-15",
    "end_time": "2025-01-29",
    "duration_days": 14,
    "parent_episode_id": "group-2025-001"
  },
  {
    "content": "成员间可能建立更多非正式沟通渠道",
    "evidence": "user_1强调了沟通效率问题",
    "start_time": "2025-01-15",
    "end_time": "2025-01-29",
    "duration_days": 14,
    "parent_episode_id": "group-2025-001"
  },
  {
    "content": "团队决策流程可能引入更多成员意见",
    "evidence": "user_2提出新的目标方向",
    "start_time": "2025-01-15",
    "end_time": "2025-02-01",
    "duration_days": 17,
    "parent_episode_id": "group-2025-001"
  },
  {
    "content": "工作任务分配会更加均衡合理",
    "evidence": "user_3表达了工作负荷压力",
    "start_time": "2025-01-15",
    "end_time": "2025-01-22",
    "duration_days": 7,
    "parent_episode_id": "group-2025-001"
  }
  ...
]

## 示例输入（生活场景）：
{
  "event_id": "group-2025-002",
  "group_id": "family_001",
  "user_id_list": ["user_1", "user_2"],
  "summary": "user_1崴脚了，user_2帮忙照顾。",
  "episode": "今天下午user_1在公园散步时不小心崴了脚，user_2立即过来帮忙，搀扶回家并帮忙买药。"
}

## 示例输出（生活场景）：
[
  {
    "content": "user_2会每天询问恢复情况并提供帮助",
    "evidence": "user_2主动搀扶user_1回家并帮忙买药",
    "start_time": "2025-10-23",
    "end_time": "2025-11-06",
    "duration_days": 14,
    "parent_episode_id": "group-2025-002"
  },
  {
    "content": "两人的互助默契会进一步加深",
    "evidence": "user_2立即过来帮忙",
    "start_time": "2025-10-23",
    "end_time": "2025-11-23",
    "duration_days": 31,
    "parent_episode_id": "group-2025-002"
  },
  {
    "content": "近期外出活动会选择更安全的场所和路线",
    "evidence": "user_1在公园散步时不小心崴了脚",
    "start_time": "2025-10-23",
    "end_time": "2025-11-06",
    "duration_days": 14,
    "parent_episode_id": "group-2025-002"
  },
  {
    "content": "可能形成相互照应的日常生活模式",
    "evidence": "user_2帮忙买药",
    "start_time": "2025-10-23",
    "end_time": "2025-11-23",
    "duration_days": 31,
    "parent_episode_id": "group-2025-002"
  }
  ...
]

## 注意事项：
- **联想导向**：重点是"群体层面的语义联想"，基于事件联想可能发生的后续群体变化，不是单个人的日常行为总结。
- **场景适配**：语言风格必须与事件场景匹配，生活场景用生活化表达，工作场景用工作化表达。
- **时间推断**：结合事件类型、常识和用户状态合理推断时间范围，不要生硬套用固定时间。
- **内容创新**：不要重复原文内容，要生成事件可能引发的新的群体行为或氛围变化。
- **语义检索友好**：content应是联想预测的结果（如"会增加沟通频率"），evidence保存原始事实（如"会议中提到沟通问题"），便于AI根据用户查询检索相关前瞻并追溯原因。
- **时间信息提取规则：**
  - start_time: 从输入内容中提取事件发生的具体日期（通常在summary或episode中），格式为YYYY-MM-DD
  - end_time: 从原文内容中提取具体的结束时间点，如果原文中有明确的结束时间（如"10月24日前"、"2025-11-15"等），则提取具体日期，否则结合事件内容和常识合理推断
  - duration_days: 从原文内容中提取持续时间，如果原文中有明确的时间描述（如"一周内"、"7天"、"一个月"等），则提取天数，否则结合事件内容和常识合理推断
  - parent_episode_id: 使用输入中的event_id
  - evidence: 从原文内容中提取支持该联想预测的具体证据，必须是原文中明确提到的事实或行为，不超过30字
  - **重要**：优先从原文中提取明确的时间信息，如果没有则结合事件内容和常识进行合理推断，时间不能为null
"""

FORESIGHT_GENERATION_PROMPT = """
你是一个高级个人语义分析智能体。你的任务是基于用户的最新MemCell事件，联想预测该事件可能对该用户个人未来行为、习惯、决策和生活方式产生的具体影响。

## 任务目标：
1. **个人层面联想**：从用户个人角度分析事件对其未来行为、思维模式、生活习惯或决策偏好的潜在影响。
2. **联想预测而非总结**：基于事件内容，联想可能发生的个人变化，而不是重复或总结原文内容。
3. **场景风格匹配**：预测内容必须符合事件发生的场景风格：
   - 生活场景（如健康、家庭、休闲、学习）→ 使用生活化用词，关注个人习惯、情感状态、生活方式、个人成长等
   - 工作场景（如职业发展、技能提升、工作方式）→ 使用工作化用词，关注职业规划、能力提升、工作习惯、专业发展等
4. **个人行为导向**：每条联想应反映用户个人的"可能变化"或"行为偏向"，聚焦个体层面的未来发展。
5. **时间维度合理**：每条预测应包含合理的时间维度，结合事件类型和个人状态推断持续时间。
6. **具体可操作**：每条预测不超过40字，必须生成恰好10条，内容具体且可验证。
7. **直接使用用户ID**：输出中应直接使用用户ID（如user_1），避免用"用户"泛称。
8. **语义关联性**：联想内容应与原事件保持语义关联，通过evidence字段存储原始事实，确保能追溯事件来源。

## 输出格式：
以JSON数组返回结果，每个联想包含时间信息和证据：
[
  {
    "content": "user_1近期应多注意情绪管理",
    "evidence": "user_1刚完成智齿拔除手术，可能有不适感",
    "start_time": "2025-10-21",
    "end_time": "2025-10-28",
    "duration_days": 7,
    "parent_episode_id": "test-001"
  },
  ...
]

## 示例输入（生活场景）：
{
  "event_id": "test-001",
  "user_id": "XiaoMing",
  "subject": "小明完成智齿拔除手术及术后医嘱",
  "summary": "小明在今天下午成功拔除了智齿，医生强调未来一周注意口腔清洁。",
  "episode": "2025年10月21日下午，小明讲述了拔牙经历，医生提醒要保持口腔清洁。"
}

## 示例输出（生活场景）：
[
  {
    "content": "XiaoMing未来一周会优先选择粥、面条等软质食物",
    "evidence": "刚拔除智齿",
    "start_time": "2025-10-21",
    "end_time": "2025-10-28",
    "duration_days": 7,
    "parent_episode_id": "test-001"
  },
  {
    "content": "XiaoMing近期饮食会避免过热、过硬、辛辣的食物",
    "evidence": "医生强调未来一周注意口腔清洁",
    "start_time": "2025-10-21",
    "end_time": "2025-10-28",
    "duration_days": 7,
    "parent_episode_id": "test-001"
  },
  {
    "content": "XiaoMing会增加使用漱口水等口腔护理产品",
    "evidence": "医生提醒要保持口腔清洁",
    "start_time": "2025-10-21",
    "end_time": "2025-11-21",
    "duration_days": 31,
    "parent_episode_id": "test-001"
  },
  {
    "content": "XiaoMing可能向朋友分享术后护理经验",
    "evidence": "小明讲述了拔牙经历",
    "start_time": "2025-10-21",
    "end_time": "2025-10-28",
    "duration_days": 7,
    "parent_episode_id": "test-001"
  },
  {
    "content": "XiaoMing会调整作息保证充足休息促进恢复",
    "evidence": "刚拔除智齿",
    "start_time": "2025-10-21",
    "end_time": "2025-10-28",
    "duration_days": 7,
    "parent_episode_id": "test-001"
  },
  {
    "content": "XiaoMing可能养成定期口腔检查的习惯",
    "evidence": "成功拔除了智齿",
    "start_time": "2025-10-21",
    "end_time": "2025-12-21",
    "duration_days": 61,
    "parent_episode_id": "test-001"
  }
  ...
]

## 示例输入（工作场景）：
{
  "event_id": "work-001",
  "user_id": "LiHua",
  "subject": "李华参加了项目管理培训",
  "summary": "李华参加了为期三天的项目管理培训，学习了新的工作方法。",
  "episode": "2025年10月21日-23日，李华参加了公司组织的项目管理培训，学习了敏捷开发方法和团队协作技巧。"
}

## 示例输出（工作场景）：
[
  {
    "content": "LiHua会采用迭代式方法推进项目任务",
    "evidence": "学习了敏捷开发方法",
    "start_time": "2025-10-24",
    "end_time": "2025-11-24",
    "duration_days": 31,
    "parent_episode_id": "work-001"
  },
  {
    "content": "LiHua可能在团队会议中分享新的工作方法",
    "evidence": "参加了为期三天的项目管理培训",
    "start_time": "2025-10-24",
    "end_time": "2025-11-07",
    "duration_days": 14,
    "parent_episode_id": "work-001"
  },
  {
    "content": "LiHua会增加与团队成员的日常沟通频率",
    "evidence": "学习了团队协作技巧",
    "start_time": "2025-10-24",
    "end_time": "2025-11-24",
    "duration_days": 31,
    "parent_episode_id": "work-001"
  },
  {
    "content": "LiHua对内部培训和外部课程的关注度会提升",
    "evidence": "公司组织的项目管理培训",
    "start_time": "2025-10-24",
    "end_time": "2025-12-24",
    "duration_days": 61,
    "parent_episode_id": "work-001"
  },
  {
    "content": "LiHua在选择工作方法时会更倾向系统化流程",
    "evidence": "学习了新的工作方法",
    "start_time": "2025-10-24",
    "end_time": "2026-01-24",
    "duration_days": 92,
    "parent_episode_id": "work-001"
  }
  ...
]

## 注意事项：
- **个人导向**：聚焦用户"个人层面的未来变化"，内容可涵盖生活、学习、工作、情绪、习惯等个人发展。
- **联想创新**：不要重复原文内容，要生成事件可能引发的个人行为、习惯或决策变化。
- **场景适配**：语言风格必须与事件场景匹配，生活场景用生活化表达，工作场景用工作化表达。
- **时间推断**：结合事件类型、个人状态和常识合理推断时间范围，不要生硬套用固定时间。
- **内容实用**：内容必须具体、合理、实用，能被系统用于个人前瞻建模。
- **语义检索友好**：content应是联想预测的结果（如"会选择软质食物"），evidence保存原始事实（如"拔除智齿"），便于AI根据用户查询（如"推荐食物"）检索相关前瞻并追溯原因。
- **时间信息提取规则：**
  - start_time: 从输入内容中提取事件发生的具体日期（通常在summary或episode中），格式为YYYY-MM-DD
  - end_time: 从原文内容中提取具体的结束时间点，如果原文中有明确的结束时间（如"10月24日前"、"2025-11-15"等），则提取具体日期，否则结合事件内容和常识合理推断
  - duration_days: 从原文内容中提取持续时间，如果原文中有明确的时间描述（如"一周内"、"7天"、"一个月"等），则提取天数，否则结合事件内容和常识合理推断
  - parent_episode_id: 使用输入中的event_id
  - evidence: 从输入内容中提取支持该联想预测的具体证据，必须是原文中明确提到的事实或行为，不超过30字
  - **重要**：优先从原文中提取明确的时间信息，如果没有则结合事件内容和常识进行合理推断，时间不能为null
"""


def get_group_foresight_generation_prompt(
    memcell_summary: str, memcell_episode: str, user_ids: list = None
) -> str:
    """
    生成群组前瞻联想预测的提示词

    Args:
        memcell_summary: MemCell的摘要内容
        memcell_episode: MemCell的详细内容
        user_ids: 用户ID列表，用于生成具体的用户ID

    Returns:
        完整的提示词字符串
    """
    # 构建用户ID信息
    user_ids_info = ""
    if user_ids:
        user_ids_info = f"\n**用户ID信息：**\n{', '.join(user_ids)}\n"

    prompt = f"""{GROUP_FORESIGHT_GENERATION_PROMPT}

## 输入内容：

**MemCell摘要：**
{memcell_summary}

**MemCell详细内容：**
{memcell_episode}{user_ids_info}
## 请基于以上内容，生成10条对用户未来生活、决策可能产生影响的联想：

"""
    return prompt


def get_foresight_generation_prompt(
    episode_memory: str, episode_content: str, user_id: str = None
) -> str:
    """
    生成个人前瞻联想预测的提示词

    Args:
        episode_memory: EpisodeMemory的摘要内容
        episode_content: EpisodeMemory的详细内容
        user_id: 用户ID，用于生成具体的用户ID

    Returns:
        完整的提示词字符串
    """
    # 构建用户ID信息
    user_id_info = ""
    if user_id:
        user_id_info = f"\n**用户ID信息：**\n{user_id}\n"

    prompt = f"""{FORESIGHT_GENERATION_PROMPT}

## 输入内容：

**EpisodeMemory摘要：**
{episode_memory}

**EpisodeMemory详细内容：**
{episode_content}{user_id_info}
## 请基于以上内容，生成10条对用户未来生活、决策可能产生影响的联想：

"""
    return prompt
