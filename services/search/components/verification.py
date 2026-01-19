from __future__ import annotations
import logging
import asyncio
import re
from typing import Any, Dict, List
from services.core.config import settings

logger = logging.getLogger(__name__)

class VerificationComponent:
    def __init__(self, llm_client):
        self.llm_client = llm_client

    def is_negative_response(self, content: str) -> bool:
        """
        Check if a response indicates "no answer found".
        """
        if not content:
            return True
        
        content_upper = content.upper().strip()
        negative_phrases = [
            "NO_ANSWER", "NO ANSWER",
            "I DON'T KNOW", "I DO NOT KNOW",
            "CONTEXT DOES NOT CONTAIN",
            "DOES NOT MENTION", "DOES NOT DISCUSS",
            "INFORMATION IS MISSING",
            "CANNOT ANSWER", "UNABLE TO ANSWER"
        ]
        
        for phrase in negative_phrases:
            if phrase in content_upper:
                return True
                
        return False



    async def filter_relevant_chunks(
        self, 
        query: str, 
        context_parts: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Enhanced filtering: supports larger top_k.
        Strategy 1: Score filtering.
        Strategy 2: Keyword matching enhancement.
        Strategy 3: Length filtering.
        """
        if not context_parts:
            return []
        
        # Strategy 1: Score filtering (if score exists)
        scored_parts = [p for p in context_parts if p.get("score", 0) > 0]
        
        if scored_parts:
            scores = [p["score"] for p in scored_parts]
            avg_score = sum(scores) / len(scores)
            max_score = max(scores)
            
            # Adaptive threshold: retain high-score chunks
            threshold = max(avg_score * 0.6, max_score * 0.5)
            filtered = [p for p in scored_parts if p["score"] >= threshold]
            
            # Retain at least 5
            if len(filtered) < 5:
                filtered = sorted(scored_parts, key=lambda x: x["score"], reverse=True)[:5]
        else:
            filtered = context_parts
        
        # Strategy 2: Enhanced keyword matching
        query_keywords = set(re.findall(r'\w+', query.lower()))
        
        for part in filtered:
            # Filter out too-short content
            if len(part["content"].strip()) < 50:
                part["keyword_overlap"] = 0
                continue
                
            content_keywords = set(re.findall(r'\w+', part["content"].lower()))
            overlap = len(query_keywords & content_keywords)
            part["keyword_overlap"] = overlap
        
        # Sort by score primarily (absolute value), usage keyword overlap as tie-breaker
        filtered.sort(
            key=lambda x: (x.get("score", 0), x.get("keyword_overlap", 0)),
            reverse=True
        )
        
        return filtered

    async def process_single_chunk(
        self, 
        query: str, 
        context_part: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Simple chunk processing: LLM answers the question or says NO_ANSWER.
        """
        system_prompt = (
            "You are a fact-based and objective assistant that provides complete answers.\n"
            "Answer the question based on the given context in 1-2 complete sentences.\n"
            "If the context does NOT directly answer the question, reply exactly: NO_ANSWER\n"
            "Do not make up connections or assumptions."
        )
        
        user_prompt = (
            f"Question: {query}\n\n"
            f"Context:\n{context_part['content']}"
        )

        try:
            response = await self.llm_client.chat_complete(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=200,
            )
            
            response = response.strip()
            response_upper = response.upper()
            
            # Check for NO_ANSWER
            if "NO_ANSWER" in response_upper or "NO ANSWER" in response_upper:
                return {
                    "index": context_part["index"],
                    "has_answer": False,
                    "content": "Model verification returned NO_ANSWER.",
                    "source": context_part["source"],
                    "confidence": 0.0
                }
            
            # Check if response is a negative response
            if not response or self.is_negative_response(response):
                return {
                    "index": context_part["index"],
                    "has_answer": False,
                    "content": f"Negative response detected: {response[:50]}...",
                    "source": context_part["source"],
                    "confidence": 0.0
                }
            
            # Has answer
            return {
                "index": context_part["index"],
                "has_answer": True,
                "content": response,
                "source": context_part["source"],
                "confidence": 1.0
            }
            
        except Exception as e:
            logger.error(f"Failed to process chunk {context_part['index']}: {e}")
            return {
                "index": context_part["index"],
                "has_answer": False,
                "content": f"Verification failed: {str(e)}",
                "source": context_part["source"],
                "confidence": 0.0
            }
