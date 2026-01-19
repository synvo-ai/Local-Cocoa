"""Search storage operations."""

from __future__ import annotations

import logging
from typing import Any, Optional

from services.core.models import SearchHit
from services.core.request_context import RequestContext, get_request_context
from .files import FileMixin

logger = logging.getLogger(__name__)


class SearchMixin:
    """Mixin for handling search operations."""

    # Note: methods like _lexical_score and _deserialize_metadata are utilized here.
    # We rely on FileMixin's implementation or define them here if unique.
    # _lexical_score logic is specific to search.

    def search_files_by_filename(
        self, 
        query: str, 
        limit: int = 10,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        L1: Fast filename matching - searches file names for query terms.
        Returns file-level hits (no chunk_id) sorted by match quality.
        
        Privacy filtering is applied to exclude private files for external requests.
        """
        terms = [t.strip().lower() for t in query.split() if len(t.strip()) >= 2]
        if not terms:
            return []

        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()

        # Build LIKE conditions for each term
        conditions = " AND ".join(["LOWER(name) LIKE ?" for _ in terms])
        params: list[Any] = [f"%{term}%" for term in terms]
        
        # Add privacy filter for external requests
        privacy_clause = ""
        if not ctx.can_access_private:
            privacy_clause = " AND privacy_level = 'normal'"
        
        params.append(limit * 2)  # Fetch extra for scoring

        sql = f"""
            SELECT id, name, path, summary, metadata
            FROM files
            WHERE {conditions}{privacy_clause}
            ORDER BY modified_at DESC
            LIMIT ?
        """

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(sql, params).fetchall()

        hits: list[SearchHit] = []
        for row in rows:
            name_lower = (row["name"] or "").lower()
            score = self._lexical_score(name_lower, terms)
            # Boost exact matches in filename
            if all(term in name_lower for term in terms):
                score = min(1.0, score + 0.2)

            metadata = FileMixin._deserialize_metadata(row["metadata"])
            metadata["path"] = row["path"]
            metadata["name"] = row["name"]

            hits.append(SearchHit(
                file_id=row["id"],
                score=score,
                summary=row["summary"],
                snippet=None,  # File-level hit, no chunk snippet
                metadata=metadata,
                chunk_id=None,
            ))

        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    def search_files_by_summary(
        self, 
        query: str, 
        limit: int = 10, 
        exclude_file_ids: set[str] | None = None,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        L2: Search file summaries for query terms.
        Returns file-level hits sorted by match quality.
        
        Privacy filtering is applied to exclude private files for external requests.
        """
        terms = [t.strip().lower() for t in query.split() if len(t.strip()) >= 2]
        if not terms:
            return []

        exclude_file_ids = exclude_file_ids or set()
        
        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()

        # Build LIKE conditions - at least one term must match
        conditions = " OR ".join(["LOWER(summary) LIKE ?" for _ in terms])
        params: list[Any] = [f"%{term}%" for term in terms]
        
        # Add privacy filter for external requests
        privacy_clause = ""
        if not ctx.can_access_private:
            privacy_clause = " AND privacy_level = 'normal'"
        
        params.append(limit * 3)

        sql = f"""
            SELECT id, name, path, summary, metadata
            FROM files
            WHERE summary IS NOT NULL AND summary != '' AND ({conditions}){privacy_clause}
            ORDER BY modified_at DESC
            LIMIT ?
        """

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(sql, params).fetchall()

        hits: list[SearchHit] = []
        for row in rows:
            if row["id"] in exclude_file_ids:
                continue

            summary_lower = (row["summary"] or "").lower()
            score = self._lexical_score(summary_lower, terms)

            metadata = FileMixin._deserialize_metadata(row["metadata"])
            metadata["path"] = row["path"]
            metadata["name"] = row["name"]

            # Create a snippet from the summary
            snippet = row["summary"][:300] if row["summary"] else None

            hits.append(SearchHit(
                file_id=row["id"],
                score=score,
                summary=row["summary"],
                snippet=snippet,
                metadata=metadata,
                chunk_id=None,
            ))

        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    def search_files_by_metadata(
        self, 
        query: str, 
        limit: int = 10, 
        exclude_file_ids: set[str] | None = None,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        L3: Search file metadata (JSON) for query terms.
        Returns file-level hits sorted by match quality.
        
        Privacy filtering is applied to exclude private files for external requests.
        """
        terms = [t.strip().lower() for t in query.split() if len(t.strip()) >= 2]
        if not terms:
            return []

        exclude_file_ids = exclude_file_ids or set()
        
        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()

        # Build LIKE conditions on metadata JSON text
        conditions = " OR ".join(["LOWER(metadata) LIKE ?" for _ in terms])
        params: list[Any] = [f"%{term}%" for term in terms]
        
        # Add privacy filter for external requests
        privacy_clause = ""
        if not ctx.can_access_private:
            privacy_clause = " AND privacy_level = 'normal'"
        
        params.append(limit * 3)

        sql = f"""
            SELECT id, name, path, summary, metadata
            FROM files
            WHERE metadata IS NOT NULL AND ({conditions}){privacy_clause}
            ORDER BY modified_at DESC
            LIMIT ?
        """

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(sql, params).fetchall()

        hits: list[SearchHit] = []
        for row in rows:
            if row["id"] in exclude_file_ids:
                continue

            metadata_text = (row["metadata"] or "").lower()
            score = self._lexical_score(metadata_text, terms)

            metadata = FileMixin._deserialize_metadata(row["metadata"])
            metadata["path"] = row["path"]
            metadata["name"] = row["name"]

            hits.append(SearchHit(
                file_id=row["id"],
                score=score,
                summary=row["summary"],
                snippet=row["summary"][:200] if row["summary"] else None,
                metadata=metadata,
                chunk_id=None,
            ))

        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    def search_snippets(
        self, 
        query: str, 
        limit: int = 10, 
        require_all_terms: bool = False, 
        file_ids: Optional[list[str]] = None,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        Lexical search using keyword matching.

        Args:
            query: Search query
            limit: Maximum number of results
            require_all_terms: If True, only return chunks containing ALL query terms (AND logic)
                              If False, return chunks with ANY terms (OR logic)
            file_ids: Optional list of file IDs to restrict search to
            ctx: Optional RequestContext for privacy filtering
            
        Privacy filtering is applied to exclude private files for external requests.
        """
        terms = [part.strip().lower() for part in query.split() if len(part.strip()) >= 2]
        if not terms:
            return []

        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()

        like_clauses: list[str] = []
        params: list[Any] = []
        for term in terms[:6]:  # Consider up to 6 terms
            pattern = f"%{term}%"
            like_clauses.append("(lower(ch.text) LIKE ? OR lower(ch.snippet) LIKE ?)")
            params.extend([pattern, pattern])

        # Use AND logic if require_all_terms=True (must match ALL terms)
        # Use OR logic otherwise (match ANY terms)
        if require_all_terms:
            where_clause = " AND ".join(like_clauses) if like_clauses else "1=1"
        else:
            where_clause = " OR ".join(like_clauses) if like_clauses else "1=1"

        if file_ids:
            placeholders = ",".join("?" for _ in file_ids)
            where_clause = f"({where_clause}) AND ch.file_id IN ({placeholders})"
            params.extend(file_ids)
        
        # Add privacy filter for external requests - filter on file's privacy level
        if not ctx.can_access_private:
            where_clause = f"({where_clause}) AND f.privacy_level = 'normal'"

        fetch_limit = max(limit * 5, 20)  # Fetch more candidates for better ranking
        sql = f"""
            SELECT
                ch.id AS chunk_id,
                ch.file_id AS file_id,
                ch.text AS chunk_text,
                ch.snippet AS chunk_snippet,
                ch.metadata AS chunk_metadata,
                ch.created_at AS chunk_created_at,
                f.summary AS file_summary,
                f.metadata AS file_metadata,
                f.path AS file_path
            FROM chunks ch
            JOIN files f ON f.id = ch.file_id
            WHERE {where_clause}
            ORDER BY ch.created_at DESC
            LIMIT ?
        """
        params.append(fetch_limit)

        with self.connect() as conn:  # type: ignore
            rows = conn.execute(sql, params).fetchall()

        hits: list[SearchHit] = []
        for row in rows:
            chunk_text = row["chunk_text"] or ""
            snippet = row["chunk_snippet"] or chunk_text[:480]
            chunk_metadata = FileMixin._deserialize_metadata(row["chunk_metadata"])
            file_metadata = FileMixin._deserialize_metadata(row["file_metadata"])
            metadata = {**file_metadata, **chunk_metadata}
            metadata.setdefault("path", row["file_path"])
            metadata.setdefault("chunk_id", row["chunk_id"])
            score = self._lexical_score(chunk_text.lower(), terms)
            hits.append(
                SearchHit(
                    file_id=row["file_id"],
                    score=score,
                    summary=row["file_summary"],
                    snippet=snippet,
                    metadata=metadata,
                    chunk_id=row["chunk_id"],
                )
            )

        hits.sort(key=lambda item: item.score, reverse=True)

        # Log top lexical hits for debugging
        if hits:
            logger.debug(f"Top lexical search results for '{query}':")
            for idx, hit in enumerate(hits[:5], 1):
                metadata = hit.metadata or {}
                label = metadata.get("path", hit.file_id)
                logger.debug(f"  {idx}. {label} (score={hit.score:.3f})")

        return hits[:limit]

    def search_snippets_fts(
        self, 
        query: str, 
        limit: int = 10, 
        file_ids: Optional[list[str]] = None,
        ctx: Optional[RequestContext] = None,
    ) -> list[SearchHit]:
        """
        Full-text search using SQLite FTS5 with BM25 ranking.
        
        This is significantly faster than LIKE queries for large datasets.
        Falls back to search_snippets if FTS5 table is not available.
        
        Args:
            query: Search query (natural language or keywords)
            limit: Maximum number of results
            file_ids: Optional list of file IDs to restrict search to
            ctx: Optional RequestContext for privacy filtering
            
        Privacy filtering is applied to exclude private files for external requests.
        """
        # Extract meaningful terms for FTS5 query
        terms = [t.strip().lower() for t in query.split() if len(t.strip()) >= 2]
        if not terms:
            return []
        
        # Get request context for privacy filtering
        if ctx is None:
            ctx = get_request_context()
        
        try:
            # Build FTS5 query - match any term (OR logic) for better recall
            fts_query = " OR ".join(f'"{term}"' for term in terms[:10])
            
            # Add privacy filter for external requests
            privacy_clause = ""
            if not ctx.can_access_private:
                privacy_clause = " AND f.privacy_level = 'normal'"
            
            # Join FTS5 results with chunks table via rowid to get file_id and chunk_id
            if file_ids:
                placeholders = ",".join("?" for _ in file_ids)
                sql = f"""
                    SELECT
                        ch.id AS chunk_id,
                        ch.file_id AS file_id,
                        fts.text AS chunk_text,
                        fts.snippet AS chunk_snippet,
                        bm25(chunks_fts) AS bm25_score,
                        f.summary AS file_summary,
                        f.metadata AS file_metadata,
                        f.path AS file_path,
                        f.name AS file_name
                    FROM chunks_fts fts
                    JOIN chunks ch ON ch.rowid = fts.rowid
                    JOIN files f ON f.id = ch.file_id
                    WHERE chunks_fts MATCH ? AND ch.file_id IN ({placeholders}){privacy_clause}
                    ORDER BY bm25_score
                    LIMIT ?
                """
                params = [fts_query] + file_ids + [limit * 2]
            else:
                sql = f"""
                    SELECT
                        ch.id AS chunk_id,
                        ch.file_id AS file_id,
                        fts.text AS chunk_text,
                        fts.snippet AS chunk_snippet,
                        bm25(chunks_fts) AS bm25_score,
                        f.summary AS file_summary,
                        f.metadata AS file_metadata,
                        f.path AS file_path,
                        f.name AS file_name
                    FROM chunks_fts fts
                    JOIN chunks ch ON ch.rowid = fts.rowid
                    JOIN files f ON f.id = ch.file_id
                    WHERE chunks_fts MATCH ?{privacy_clause}
                    ORDER BY bm25_score
                    LIMIT ?
                """
                params = [fts_query, limit * 2]
            
            with self.connect() as conn:  # type: ignore
                rows = conn.execute(sql, params).fetchall()
            
            hits: list[SearchHit] = []
            for row in rows:
                chunk_text = row["chunk_text"] or ""
                snippet = row["chunk_snippet"] or chunk_text[:480]
                file_metadata = FileMixin._deserialize_metadata(row["file_metadata"])
                file_metadata.setdefault("path", row["file_path"])
                file_metadata.setdefault("name", row["file_name"])
                file_metadata.setdefault("chunk_id", row["chunk_id"])
                
                # BM25 returns negative scores (lower = better) in SQLite's implementation
                # We return the absolute value so that Higher is Better.
                # No normalization: returning raw BM25 magnitude.
                raw_score = row["bm25_score"]
                normalized_score = abs(raw_score)
                
                hits.append(SearchHit(
                    file_id=row["file_id"],
                    score=normalized_score,
                    summary=row["file_summary"],
                    snippet=snippet,
                    metadata=file_metadata,
                    chunk_id=row["chunk_id"],
                ))
            
            # --- Adaptive Threshold & Normalization ---
            if hits:
                # 1. Truncation (Adaptive Thresholding)
                # Filter out broad matches that are significantly worse than the best match.
                # Heuristic: Keep hits with > 25% of the top score.
                top_score = hits[0].score # hits are already sorted by raw magnitude
                cutoff = top_score * 0.25
                hits = [h for h in hits if h.score >= cutoff]
                
                # 2. Max Number (Hard Cap)
                # User requested "No Normalization" (don't scale to 0-1).
                # But requested a "Max Number". We interpret this as a Ceiling/Clamp.
                # We cap the score at 25.0 to prevent UI issues with extremely high scores,
                # but we preserve the raw magnitude below that.
                MAX_BM25_SCORE = 25.0
                for h in hits:
                     h.score = min(h.score, MAX_BM25_SCORE)

            if hits:
                logger.debug(f"FTS5 search found {len(hits)} results (filtered & capped)")
            
            return hits[:limit]
            
        except Exception as e:
            # FTS5 table might not exist or be populated yet, fall back to LIKE
            logger.warning(f"FTS5 search failed, falling back to LIKE: {e}")
            return self.search_snippets(query, limit=limit, file_ids=file_ids, ctx=ctx)

    def rebuild_fts_index(self) -> int:
        """
        Rebuild the FTS5 index from existing chunks.
        
        Call this after initial data migration or if FTS5 becomes out of sync.
        Returns the number of chunks indexed.
        """
        with self.connect() as conn:  # type: ignore
            # Clear existing FTS5 data
            conn.execute("DELETE FROM chunks_fts")
            
            # Rebuild from chunks table
            conn.execute("""
                INSERT INTO chunks_fts(rowid, text, snippet)
                SELECT rowid, text, snippet FROM chunks
            """)
            
            # Get count of indexed chunks
            cursor = conn.execute("SELECT COUNT(*) FROM chunks_fts")
            count = cursor.fetchone()[0]
            logger.info(f"Rebuilt FTS5 index with {count} chunks")
            return count

    @staticmethod
    def _lexical_score(text: str, terms: list[str]) -> float:
        """
        Calculate lexical match score with strong emphasis on matching ALL query terms.
        """
        if not text or not terms:
            return 0.0

        text_lower = text.lower()

        # Check for exact phrase match (all terms in order)
        query_phrase = " ".join(terms)
        if query_phrase in text_lower:
            return 1.0

        # Count matched terms
        matched_terms = sum(1 for term in terms if term in text_lower)
        if matched_terms == 0:
            return 0.1

        # Calculate match ratio
        match_ratio = matched_terms / len(terms)

        # CRITICAL: Use exponential scoring to heavily favor complete matches
        if match_ratio == 1.0:
            # Perfect match of all terms (but not exact phrase) → very high score
            base_score = 0.95
        else:
            # Use quadratic curve to emphasize completeness
            # Formula: 0.2 + (ratio^2 * 0.65)
            base_score = 0.2 + (match_ratio ** 2) * 0.65

        # Bonus for multiple occurrences (more mentions = more relevant)
        total_occurrences = sum(text_lower.count(term) for term in terms)
        frequency_bonus = min(0.05, (total_occurrences - matched_terms) * 0.01)

        # Extra bonus for matching many terms (scales with query complexity)
        if matched_terms >= 3 and match_ratio >= 0.8:
            completeness_bonus = 0.1 * (matched_terms / len(terms))
        else:
            completeness_bonus = 0.0

        final_score = base_score + frequency_bonus + completeness_bonus

        return min(1.0, final_score)
