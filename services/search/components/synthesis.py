from __future__ import annotations
import logging
import re
from typing import Any, Dict, List, AsyncIterable

logger = logging.getLogger(__name__)

class SynthesisComponent:
    def __init__(self, llm_client):
        self.llm_client = llm_client

    def deduplicate_sub_answers(self, sub_answers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Removes duplicate or highly similar sub-answers.
        """
        # Helper to check negative response logic roughly (could inject VerificationComponent or duplicate simple check)
        # For independence, strict "negative response" check might be better passed in or duplicated.
        # I'll implement a simple local check to reuse logic without circular dependency.
        def _is_neg(content):
            if not content: return True
            c = content.upper()
            return "NO_ANSWER" in c or "NO ANSWER" in c or "I DON'T KNOW" in c

        if len(sub_answers) <= 3:
            return [
                ans for ans in sub_answers 
                if ans.get("has_answer") and not _is_neg(ans.get("content", ""))
            ]
        
        unique_answers = []
        seen_contents = []
        
        for answer in sub_answers:
            if not answer.get("has_answer"):
                continue
            
            content = answer.get("content", "")
            if _is_neg(content):
                continue
            
            content_lower = content.lower()
            words = set(re.findall(r'\w+', content_lower))
            
            if not words:
                continue
            
            # Check if this answer is a duplicate
            is_duplicate = False
            for seen_words in seen_contents:
                overlap = len(words & seen_words)
                similarity = overlap / max(len(words), len(seen_words), 1)
                if similarity > 0.75:
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                unique_answers.append(answer)
                seen_contents.append(words)
        
        return unique_answers

    async def aggregate_sub_answers(
        self, 
        query: str, 
        sub_answers: List[Dict[str, Any]]
    ) -> str:
        """
        Optimized aggregation.
        """
        unique_answers = self.deduplicate_sub_answers(sub_answers)
        
        if not unique_answers:
            return "I cannot find a clear answer in your documents."
        
        unique_answers.sort(key=lambda x: x.get("confidence", 0), reverse=True)
        
        if len(unique_answers) <= 8:
            return await self.simple_aggregation(query, unique_answers)
        
        return await self.hierarchical_aggregation(query, unique_answers)

    async def simple_aggregation(
        self, 
        query: str, 
        sub_answers: List[Dict[str, Any]]
    ) -> str:
        """
        Aggregate multiple sub-answers into a comprehensive response.
        """
        evidence_lines = [
            f"[{ans['index']}] (Source: {ans.get('source', 'Unknown')}, Confidence: {ans.get('confidence', 0):.1f})\n{ans['content']}"
            for ans in sub_answers
            if ans.get('content')
        ]
        evidence_text = "\n\n".join(evidence_lines)
        
        if not evidence_text.strip():
            return "I cannot find a clear answer in the provided documents."
        
        system_prompt = (
            "You are a strict, fact-based assistant. Answer the question based ONLY on the provided evidence. "
            "If the evidence does not contain the specific information requested, explicitly state it is not available. "
            "Do NOT infer or guess. Cite each fact using the numbered brackets from evidence."
        )
        
        user_prompt = (
            f"Question: {query}\n\n"
            f"Evidence:\n{evidence_text}\n\n"
            "Answer in 1-2 sentences. Cite each fact with its source number in brackets."
        )
        
        try:
            final_answer = await self.llm_client.chat_complete(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_tokens=250,
            )
            return final_answer.strip()
        except Exception as e:
            logger.error(f"Aggregation failed: {e}")
            if sub_answers:
                best = max(sub_answers, key=lambda x: x.get('confidence', 0))
                return f"{best['content']} [{best['index']}]"
            return "Synthesis error."

    async def stream_simple_aggregation(
        self,
        query: str,
        sub_answers: List[Dict[str, Any]]
    ) -> AsyncIterable[str]:
        """
        Streaming version of simple_aggregation.
        """
        evidence_lines = [
            f"[{ans['index']}] (Source: {ans.get('source', 'Unknown')})\n{ans['content']}"
            for ans in sub_answers
            if ans.get('content')
        ]
        evidence_text = "\n\n".join(evidence_lines)

        if not evidence_text.strip():
             yield "I cannot find a clear answer in the provided documents."
             return

        system_prompt = (
            "You are a strict, fact-based assistant. Answer the question based ONLY on the provided evidence. "
            "If the evidence does not contain the specific information requested (e.g., specific year or figure), "
            "explicitly state that the information is not available. "
            "Do NOT infer, guess, or use data from other years to fill gaps. "
            "CRITICAL: Use ONLY the exact bracket format [N] for citations where N is the evidence number. "
            "Do NOT write 'Evidence [N]' or '(source N)' - just [N]. "
            "IMPORTANT: Do NOT repeat yourself. Give a single, concise answer."
        )

        user_prompt = (
            f"Question: {query}\n\n"
            f"Evidence:\n{evidence_text}\n\n"
            "Answer in 1-2 sentences. Cite facts using [N] format. Do not repeat."
        )

        # DEBUG LOGGING
        logger.warning("=" * 80)
        logger.warning("[SYNTHESIS DEBUG] stream_simple_aggregation called")
        logger.warning(f"[SYNTHESIS DEBUG] Query: {query}")
        logger.warning(f"[SYNTHESIS DEBUG] Number of sub_answers: {len(sub_answers)}")
        logger.warning(f"[SYNTHESIS DEBUG] System Prompt:\n{system_prompt}")
        logger.warning(f"[SYNTHESIS DEBUG] User Prompt:\n{user_prompt}")
        logger.warning(f"[SYNTHESIS DEBUG] max_tokens=250")
        logger.warning("=" * 80)

        collected_answer = []
        try:
            async for token in self.llm_client.stream_chat_complete(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_tokens=250,
            ):
                collected_answer.append(token)
                yield token
            
            # Log final answer
            logger.warning(f"[SYNTHESIS DEBUG] Final Answer: {''.join(collected_answer)}")
            logger.warning("=" * 80)
        except Exception as e:
            logger.error(f"Streaming aggregation failed: {e}")
            if sub_answers:
                best = max(sub_answers, key=lambda x: x.get('confidence', 0))
                yield f"{best['content']} [{best['index']}]"
            else:
                yield "Synthesis error."

    async def hierarchical_aggregation(
        self, 
        query: str, 
        sub_answers: List[Dict[str, Any]]
    ) -> str:
        """
        Two-stage hierarchical aggregation.
        """
        batch_size = 6
        intermediate_summaries = []
        
        for i in range(0, len(sub_answers), batch_size):
            batch = sub_answers[i:i + batch_size]
            group_num = i // batch_size + 1
            try:
                summary = await self.simple_aggregation(query, batch)
                intermediate_summaries.append({
                    "content": summary,
                    "source": f"Group {group_num}",
                    "index": group_num,
                    "has_answer": True,
                    "confidence": 0.8
                })
            except Exception as e:
                continue
        
        if not intermediate_summaries:
            return "Unable to synthesize answer from the provided documents."
        
        if len(intermediate_summaries) == 1:
            return intermediate_summaries[0]["content"]
        
        summaries_text = "\n\n".join(
            f"[Group {s['index']}]\n{s['content']}"
            for s in intermediate_summaries
        )
        
        system_prompt = (
            "You are a strict, fact-based research analyst. Integrate multiple group summaries into one authoritative answer based ONLY on the provided summaries.\n"
            "If the information is missing, state it clearly. Do NOT invent or infer data.\n"
            "IMPORTANT: Preserve the original citations (e.g. [12], [32]) found in the summaries. Do NOT use [Group n] citations."
        )
        
        user_prompt = (
            f"Question: {query}\n\n"
            f"Group Summaries:\n{summaries_text}\n\n"
            "Final Answer:"
        )
        
        try:
            final_answer = await self.llm_client.chat_complete(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_tokens=600,
                temperature=0.3,
            )
            return final_answer.strip()
        except Exception as e:
            logger.error(f"Final synthesis failed: {e}")
            return intermediate_summaries[0]["content"]
