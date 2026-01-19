import asyncio
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock
# Mock missing dependency
sys.modules["qdrant_client"] = MagicMock()
sys.modules["qdrant_client.models"] = MagicMock()

from services.search.progressive import search_pipeline
from services.search.types import SearchMethod, AnswerReadiness, MethodRunResult
from services.core.models import SearchHit

# Mock Engine
class MockEngine:
    def __init__(self):
        self.llm_client = AsyncMock()
        self.storage = MagicMock()
        self.embeddings_ready = lambda: True
    
    async def _lexical_backfill(self, *args, **kwargs):
        return [SearchHit(fileId="f1", score=0.5, snippet="Lexical", metadata={"path": "doc1.txt"})]
        
    async def _vector_hits(self, *args, **kwargs):
        return [SearchHit(fileId="f2", score=0.8, snippet="Vector", metadata={"path": "doc2.txt"})]
        
    async def _rerank_hits(self, query, hits, **kwargs):
        return sorted(hits, key=lambda x: x.score, reverse=True)
    
    async def _chunk_text(self, hit):
        return hit.snippet

class TestProgressivePipeline(unittest.IsolatedAsyncioTestCase):
    async def test_full_pipeline(self):
        engine = MockEngine()
        
        # Mock dependencies in services.search.progressive
        import services.search.progressive as prog
        
        # Mock methods list to strict set
        # method 1: m1 (fast)
        # method 2: m2 (slow)
        m1 = SearchMethod(name="m1", enabled=True, cost_level=1, top_k=5)
        m2 = SearchMethod(name="m2", enabled=True, cost_level=2, top_k=5)
        prog.build_method_list = MagicMock(return_value=[m1, m2])
        
        # Mock method functions
        async def mock_search_fn(*args, **kwargs):
            return [prog.Candidate(
                chunk_id="c1", 
                text_preview="content", 
                score=0.8,
                sub_question_id="sq1",
                route="m1",
                query_used="q",
                file_id="f1",
                meta={}
            )]
        prog.get_method_fn = MagicMock(return_value=mock_search_fn)
        
        # Mock dedup
        prog.dedup_and_merge = MagicMock(side_effect=lambda pool, new: new)
        prog.pre_rerank = MagicMock(side_effect=lambda pool, q, b: pool)
        prog.verify_candidates_batch = AsyncMock(return_value=[]) # Return empty verified for simplicity
        
        # Mock check_answer_ready
        # Call 1 (m1): Partial
        # Call 2 (m2): Good
        mock_check = AsyncMock(side_effect=[
            (AnswerReadiness.PARTIAL_ANSWER, 0.5, "Partial"),
            (AnswerReadiness.GOOD_ANSWER, 0.9, "Good")
        ])
        prog.check_answer_ready = mock_check
        
        prog.extract_keywords = MagicMock(return_value=["key"])
        
        # Run
        sub_queries = [{"id": "sq1", "text": "Query 1"}]
        pipeline_output = await search_pipeline(engine, "Full Query", sub_queries)
        
        results = pipeline_output["sub_results"]
        self.assertEqual(len(results), 1)
        res = results[0]
        # Should have run both because first was partial
        self.assertEqual(len(res["runs"]), 2)
        self.assertEqual(res["best_so_far"], "Good")
        # GOOD_ANSWER triggers early exit logic which sets needs_user_decision=True
        self.assertTrue(res["needs_user_decision"])
        self.assertIsNotNone(res["resume_token"])

    async def test_early_exit(self):
        engine = MockEngine()
        import services.search.progressive as prog
        
        m1 = SearchMethod(name="m1", enabled=True, cost_level=1, top_k=5)
        m2 = SearchMethod(name="m2", enabled=True, cost_level=2, top_k=5)
        prog.build_method_list = MagicMock(return_value=[m1, m2])
        
        # Mock check to return GOOD immediately
        prog.check_answer_ready = AsyncMock(return_value=(AnswerReadiness.GOOD_ANSWER, 0.95, "Perfect"))
        
        sub_queries = [{"id": "sq1", "text": "Query 1"}]
        pipeline_output = await search_pipeline(engine, "Full Query", sub_queries)
        
        res = pipeline_output["sub_results"][0]
        self.assertEqual(len(res["runs"]), 1) # Should stop after m1
        self.assertTrue(res["needs_user_decision"])
        
    async def test_resume(self):
        engine = MockEngine()
        import services.search.progressive as prog
        
        m1 = SearchMethod(name="m1", enabled=True, cost_level=1, top_k=5)
        m2 = SearchMethod(name="m2", enabled=True, cost_level=2, top_k=5)
        prog.build_method_list = MagicMock(return_value=[m1, m2])
        
        # Manually create a resume token that says "we finished m1"
        # token format: base64(json({sq_id, last_method=m1, ...}))
        import base64, json
        token_data = {"sq_id": "sq1", "last_method": "m1", "pool_keys": []}
        token = base64.b64encode(json.dumps(token_data).encode()).decode()
        
        # Check logic: should skip m1 and run m2
        prog.check_answer_ready = AsyncMock(return_value=(AnswerReadiness.PARTIAL_ANSWER, 0.6, "Still Partial"))
        
        sub_queries = [{"id": "sq1", "text": "Query 1"}]
        pipeline_output = await search_pipeline(engine, "Full Query", sub_queries, resume_token=token)
        
        res = pipeline_output["sub_results"][0]
        self.assertEqual(len(res["runs"]), 1)
        self.assertEqual(res["runs"][0]["method_name"], "m2") # Started from m2

if __name__ == "__main__":
    unittest.main()
