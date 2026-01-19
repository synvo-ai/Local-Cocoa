from __future__ import annotations
import logging
import json
import asyncio
import re
import uuid
import time
from typing import Any, Dict, List, Tuple, Optional
from services.search.types import SubQuestion, DebugStep

logger = logging.getLogger(__name__)

class IntentComponent:
    def __init__(self, llm_client):
        self.llm_client = llm_client

    def detect_document_intent_by_rules(self, query: str) -> bool:
        """
        Rule-based shortcut to detect document intent.
        Returns True if the query clearly refers to documents.
        This avoids unnecessary LLM calls for obvious cases.
        """
        query_lower = query.lower().strip()
        
        # Pattern 1: @ mentions (file references)
        if "@" in query:
            return True
        
        # Pattern 2: Common file extensions
        file_extensions = [".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".xlsx", ".xls", ".ppt", ".pptx"]
        for ext in file_extensions:
            if ext in query_lower:
                return True
        
        return False

    async def query_intent_routing(self, query: str, max_retries: int = 3) -> Dict[str, Any]:
        """
        Route query to appropriate handler based on intent classification.
        """
        # Step 1: Rule-based shortcut - if obvious document intent, skip LLM call
        if self.detect_document_intent_by_rules(query):
            logger.info(f"🔀 Rule-based routing: detected document intent for '{query[:50]}...'")
            return {
                "intent": "document",
                "call_tools": True,
                "confidence": 1.0
            }
        
        # Step 2: Use LLM for ambiguous cases
        system_prompt = """You are an intent classifier for a document workspace.
Your task is to classify the user's query into ONE of the following categories
and respond with JSON ONLY.

Classification categories:
1. "greeting" - Simple greetings or thanks (hi, hello, thanks, bye)
2. "general_chat" - Casual conversation, opinions, or questions not tied to any document
3. "document" - Any query related to documents, files, PDFs, reports, notes, or their content,
   including summarization, comparison, explanation, lookup, or analysis.
   If the user mentions or implies a document (e.g. @file.pdf), it MUST be classified as "document".

Response format (JSON only, no markdown, no extra text):
{
  "intent": "greeting | general_chat | document",
  "confidence": 0.0 to 1.0
}
"""

        for attempt in range(max_retries):
            try:
                # Call LLM
                routing_result = await self.llm_client.chat_complete(
                    [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": query}
                    ],
                    max_tokens=100
                )
                
                # Try to parse the result
                parsed_result = self.parse_routing_result(routing_result)
                
                # If parsing succeeds and confidence > 0, it is a valid result
                if parsed_result["confidence"] > 0:
                    # Step 3: Code decides whether to call tools (not LLM)
                    intent = parsed_result["intent"]
                    if intent == "document":
                        return {
                            "intent": "document",
                            "call_tools": True,
                            "confidence": parsed_result["confidence"]
                        }
                    else:
                        # greeting or general_chat
                        return {
                            "intent": intent,
                            "call_tools": False,
                            "confidence": parsed_result["confidence"]
                        }
                    
            except Exception as e:
                logger.error(f"✗ Error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1)
                    continue
        
        # All retries failed, return default fallback (assume document intent for safety)
        return {
            "intent": "document",
            "call_tools": True,
            "confidence": 0.0
        }

    def parse_routing_result(self, raw_result: str) -> Dict[str, Any]:
        """
        Parse LLM's routing result.
        """
        try:
            # Clean potential markdown code block markers
            cleaned = raw_result.strip()
            if '```' in cleaned:
                cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned)
                cleaned = re.sub(r'\n?```\s*$', '', cleaned)
                cleaned = cleaned.strip()
            
            # Try to extract JSON (if other text exists)
            json_match = re.search(r'\{[^{}]*\}', cleaned)
            if json_match:
                cleaned = json_match.group(0)
            
            # Parse JSON
            result = json.loads(cleaned)
            
            # Check required fields
            if "intent" not in result:
                raise ValueError("Missing 'intent' field in routing result")
            
            # Set default confidence if not present
            if "confidence" not in result:
                result["confidence"] = 0.5
            
            # Validate intent - now only 3 categories
            valid_intents = ["greeting", "general_chat", "document"]
            if result["intent"] not in valid_intents:
                result["intent"] = "document"
                result["confidence"] = max(0.3, result.get("confidence", 0.3))
            
            return result
            
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Routing parsing error: {e}")
            return {
                "intent": "document",
                "confidence": 0.0
            }

    async def analyze_query(self, query: str) -> dict:
        """
        Use LLM to determine the best retrieval strategy for a query.
        """
        logger.info(f"Analyzing query intent: {query}")
        if len(query.strip()) < 4:
            return {"needs_decomposition": False, "sub_queries": [query], "strategy": "SINGLE"}

        # Ultra-simple prompt for 2B model
        system_prompt = """Split query into questions ending with ?
Translate non-English to English.
Format: {"queries": ["question1?", "question2?"]}
Example: "revenue 2022-2024" → {"queries": ["What was revenue in 2022?", "What was revenue in 2023?", "What was revenue in 2024?"]}"""

        try:
            result = await self.llm_client.chat_complete(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Query: {query}"}
                ],
                max_tokens=256,
                temperature=0.1,
            )
            
            result = result.strip()
            logger.debug(f"Raw LLM analysis response:\n{result}")
            
            # Parsing Strategy
            strategy = "SINGLE"
            strategy_match = re.search(r"STRATEGY:\s*(\w+)", result, re.IGNORECASE)
            if strategy_match:
                strategy = strategy_match.group(1).upper()
            
            # Parsing Queries
            sub_queries = []
            # Try line-based parsing first
            lines = result.split("\n")
            in_queries_section = False
            for line in lines:
                line = line.strip()
                if "QUERIES:" in line.upper():
                    in_queries_section = True
                    continue
                if (in_queries_section or len(sub_queries) > 0) and (line.startswith("-") or line.startswith("*") or re.match(r"^\d+\.", line)):
                    query_text = re.sub(r"^[-\*\s\d\.]+", "", line).strip()
                    if query_text:
                        sub_queries.append(query_text)
            
            # Fallback to simple list if no section markers found but lines look like a list
            if not sub_queries:
                for line in lines:
                    line = line.strip()
                    if line.startswith("- ") or line.startswith("* "):
                        sub_queries.append(line[2:].strip())

            # Fallback to JSON parsing
            if not sub_queries:
                json_match = re.search(r'\{[^{}]*\}', result, re.DOTALL)
                if json_match:
                    try:
                        parsed = json.loads(json_match.group(0))
                        strategy = parsed.get("strategy", strategy)
                        sub_queries = parsed.get("queries", parsed.get("sub_queries", []))
                    except: pass

            if not sub_queries:
                sub_queries = [query]
            
            needs_multi = strategy != "SINGLE" or len(sub_queries) > 1
            
            # Deduplicate and ensure question format
            seen = set()
            filtered = []
            for sq in sub_queries:
                sq_clean = str(sq).strip()
                if not sq_clean or sq_clean.lower() in seen:
                    continue
                # Ensure proper question format
                sq_clean = self.ensure_question_format(sq_clean, query)
                if not sq_clean:
                    continue
                seen.add(sq_clean.lower())
                filtered.append(sq_clean)
            
            if not filtered:
                filtered = [self.ensure_question_format(query, query)]
                needs_multi = False

            logger.info(f"Analysis result: strategy={strategy}, multi_path={needs_multi}")
            
            return {
                "needs_decomposition": needs_multi,
                "sub_queries": filtered[:6],
                "strategy": strategy
            }
            
        except Exception as e:
            logger.error(f"Critical error in query analysis: {e}")
            return {
                "needs_decomposition": False, 
                "sub_queries": [query], 
                "strategy": "ERROR",
                "reasoning": str(e)
            }

    def ensure_question_format(self, text: str, original_query: str) -> str:
        """Ensure text ends with a question mark. Reject if too short."""
        text = text.strip()
        if not text or len(text) < 6:
            return ""
        if text.endswith('?') or text.endswith('？'):
            return text
        return text + '?'
