import asyncio
import json
import time
from unittest.mock import MagicMock, AsyncMock
from typing import AsyncGenerator
import sys
import os

# Add project root to path
sys.path.append(os.getcwd())

# MOCK DEPENDENCIES BEFORE IMPORTING PIPELINE
# qdrant_client is not installed in the python environment where this script runs? 
# Or just mock it to be safe since we don't need the real DB.
sys.modules["qdrant_client"] = MagicMock()
sys.modules["qdrant_client.models"] = MagicMock()

from services.search.pipelines.multipath import MultiPathPipeline

# Mock StandardPipeline to emit specific events
class MockStandardPipeline:
    async def execute(self, query, limit, step_generator, title_prefix=""):
        # Emulate hits found
        yield {"type": "hits", "data": [{"chunk_id": "c1", "content": "doc content"}]}
        
        # Emulate sub_answers (one valid, one "NO_ANSWER")
        yield {
            "type": "sub_answers", 
            "data": [
                {
                    "has_answer": True, 
                    "content": "This is a valid answer.", 
                    "confidence": 0.9,
                    "source": "doc1"
                },
                 {
                    "has_answer": False, 
                    "content": "Model verification returned NO_ANSWER.", # Diagnostic message
                    "confidence": 0.0,
                    "source": "doc2"
                }
            ]
        }

async def run_test():
    engine = MagicMock()
    intent = MagicMock()
    synthesis = MagicMock()
    synthesis.stream_simple_aggregation = AsyncMock(return_value=iter(["Final ", "Answer"]))
    
    standard_pipeline = MockStandardPipeline()
    
    pipeline = MultiPathPipeline(engine, intent, synthesis, standard_pipeline)
    
    payload = MagicMock()
    payload.query = "Complex Query"
    
    # Mock analysis result with plain strings to test conversion
    analysis = {"sub_queries": ["Sub Q1", "Sub Q2"]}
    
    print("--- Starting Pipeline Verification ---")
    
    events = []
    async for event_str in pipeline.execute(payload, limit=5, analysis=analysis):
        events.append(json.loads(event_str))

    # 1. Verify Subquery Metadata Format
    decompose_step = next((e for e in events if e.get("type") == "thinking_step" and e["data"]["type"] == "decompose"), None)
    if decompose_step:
        sub_queries_meta = decompose_step["data"]["metadata"]["sub_queries"]
        print(f"✅ [Display] Decompose Metadata: {sub_queries_meta}")
        assert isinstance(sub_queries_meta[0], dict), "Subqueries should be objects"
        assert "text" in sub_queries_meta[0], "Subquery object must have 'text' field"
    else:
        print("❌ [Display] Decompose step not found")

    # 2. Verify Subquery Answers
    subquery_complete_steps = [e for e in events if e.get("type") == "thinking_step" and e["data"]["type"] == "subquery" and e["data"]["status"] == "complete"]
    for step in subquery_complete_steps:
        if "subQueryAnswer" in step["data"]:
            print(f"✅ [Answer] Subquery Answer (Step {step['data']['id']}): {step['data']['subQueryAnswer']}")
        else:
            print(f"❌ [Answer] Missing subQueryAnswer in step {step['data']['id']}")

    # 3. Verify Timestamps
    timestamps = [e.get("data", {}).get("timestamp_ms") for e in events if e.get("type") == "thinking_step"]
    valid_timers = [t for t in timestamps if t is not None and t > 0]
    if valid_timers:
        print(f"✅ [Timer] Valid timestamps detected (Sample: {valid_timers[:3]}ms)")
    else:
        print(f"❌ [Timer] No valid timestamps found (All 0 or missing? {timestamps})")
        
    print("--- Verification Complete ---")

if __name__ == "__main__":
    asyncio.run(run_test())
