from __future__ import annotations

import logging
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    fitz = None

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:  # pragma: no cover
    np = None
    HAS_NUMPY = False

from .base import BaseParser, ParsedContent

logger = logging.getLogger(__name__)


class PdfParser(BaseParser):
    extensions = {"pdf"}

    def parse(self, path: Path) -> ParsedContent:
        if not fitz:
            raise ImportError("PyMuPDF (fitz) is not installed. Please install it with `pip install pymupdf`.")

        doc = fitz.open(str(path))

        try:
            if doc.is_encrypted:
                doc.authenticate("")

            texts: list[str] = []
            # List of (start_offset, end_offset, page_num) in the concatenated full_text.
            page_mapping: list[tuple[int, int, int]] = []

            total_pages = len(doc)
            cursor = 0

            for page_index, page in enumerate(doc, start=1):
                # Use enhanced extraction logic
                text = self._extract_text_enhanced(page)
                texts.append(text)

                start = cursor
                cursor += len(text)

                # Include separator in the page range so there are no gaps
                if page_index < total_pages:
                    cursor += 2  # "\n\n"

                end = cursor
                page_mapping.append((start, end, page_index))

            text = "\n\n".join(texts)

            metadata = {
                "source": "pdf",
                "pages": total_pages,
                "page_texts": text,  # This might be large, but kept for compatibility
                "preview": self._truncate(text),
            }

            return ParsedContent(
                text=text,
                metadata=metadata,
                page_count=total_pages,
                page_mapping=page_mapping,
            )

        finally:
            doc.close()

    def _extract_images(self, page) -> list[dict]:
        """Extract images from a PyMuPDF page as bytes."""
        images = []
        try:
            doc = page.parent
            for img in page.get_images(full=True):
                xref = img[0]
                image_info = doc.extract_image(xref)
                image_bytes = image_info.get("image")
                image_ext = image_info.get("ext")
                images.append(
                    {
                        "xref": xref,
                        "image_bytes": image_bytes,
                        "image_ext": image_ext,
                    }
                )
        except Exception:
            return []
        return images

    def _extract_text_from_bboxes(self, image, bboxes: list[dict] | list[tuple]) -> str:
        """Extract text by reusing layout refinement on OCR bbox outputs."""
        page_width, page_height = self._get_image_size(image)
        if page_width <= 0 or page_height <= 0 or not bboxes:
            return ""

        words = []
        for idx, item in enumerate(bboxes):
            if isinstance(item, dict):
                text = (item.get("text") or "").strip()
                x0 = float(item.get("x0", 0))
                y0 = float(item.get("y0", 0))
                x1 = float(item.get("x1", 0))
                y1 = float(item.get("y1", 0))
                block_no = int(item.get("block_no", 0))
                line_no = int(item.get("line_no", 0))
                word_no = int(item.get("word_no", idx))
            else:
                x0, y0, x1, y1, text = item[:5]
                block_no = item[5] if len(item) > 5 else 0
                line_no = item[6] if len(item) > 6 else 0
                word_no = item[7] if len(item) > 7 else idx
                text = (text or "").strip()
            if not text:
                continue
            words.append((x0, y0, x1, y1, text, block_no, line_no, word_no))

        if not words:
            return ""

        words = self._filter_artifacts(words, page_width)

        blocks_map = {}
        for w in words:
            x0, y0, x1, y1, text, block_no, line_no, word_no = w
            if block_no not in blocks_map:
                blocks_map[block_no] = {
                    "words": [],
                    "bbox": [x0, y0, x1, y1],
                }
            b = blocks_map[block_no]
            b["words"].append(w)
            b["bbox"][0] = min(b["bbox"][0], x0)
            b["bbox"][1] = min(b["bbox"][1], y0)
            b["bbox"][2] = max(b["bbox"][2], x1)
            b["bbox"][3] = max(b["bbox"][3], y1)

        blocks = list(blocks_map.values())

        def process_block_group(block_list):
            if not block_list:
                return ""
            block_list.sort(key=lambda b: b["bbox"][1])
            all_words = []
            for b in block_list:
                b_words = sorted(b["words"], key=lambda w: (w[3], w[0]))
                all_words.extend(b_words)
            all_words.sort(key=lambda w: (w[1], w[0]))
            return self._words_to_text(all_words)

        if HAS_NUMPY and len(blocks) >= 3:
            layout_groups = self._hierarchical_layout_clustering(blocks, page_width, page_height)
            if layout_groups and len(layout_groups) > 1:
                group_texts = []
                for group_blocks in layout_groups:
                    if group_blocks:
                        group_text = self._recursive_xy_cut(
                            group_blocks, page_width, page_height, process_block_group
                        )
                        group_texts.append(group_text)
                return "\n\n".join(group_texts)

        return self._recursive_xy_cut(blocks, page_width, page_height, process_block_group)

    def _extract_text_enhanced(self, page) -> str:
        """
        Enhanced text extraction heuristic:
        1. Get all words with bbox.
        2. Detect layout via clustering to identify columns.
        3. Sort and assemble lines within each column.
        4. Intelligent paragraph merging.
        """
        # (x0, y0, x1, y1, "word", block_no, line_no, word_no)
        words = page.get_text("words")  
        if not words:
            return ""

        words = self._filter_artifacts(words, page.rect.width)

        page_width = page.rect.width

        # Group words by block to handle "Header" vs "Column" detection
        blocks_map = {}
        for w in words:
            x0, y0, x1, y1, text, block_no, line_no, word_no = w
            if block_no not in blocks_map:
                blocks_map[block_no] = {
                    "words": [],
                    "bbox": [x0, y0, x1, y1]  # min_x, min_y, max_x, max_y
                }
            b = blocks_map[block_no]
            b["words"].append(w)
            
            # Update bbox
            b["bbox"][0] = min(b["bbox"][0], x0)
            b["bbox"][1] = min(b["bbox"][1], y0)
            b["bbox"][2] = max(b["bbox"][2], x1)
            b["bbox"][3] = max(b["bbox"][3], y1)

        blocks = list(blocks_map.values())
        
        # Helper to process a group of blocks (LEAF NODE)
        def process_block_group(block_list):
            if not block_list:
                return ""
            # Sort blocks primarily by Y
            block_list.sort(key=lambda b: b["bbox"][1])
            
            # Gather all words from these blocks
            all_words = []
            for b in block_list:
                b_words = sorted(b["words"], key=lambda w: (w[3], w[0]))
                all_words.extend(b_words)
            
            # Re-sort all words by Y, then X for line processing
            all_words.sort(key=lambda w: (w[1], w[0]))
            return self._words_to_text(all_words)

        # Use hierarchical Y-X clustering for layout detection if numpy is available
        if HAS_NUMPY and len(blocks) >= 3:
            layout_groups = self._hierarchical_layout_clustering(blocks, page_width, page.rect.height)
            if layout_groups and len(layout_groups) > 1:
                # Process each layout group in order (already sorted by reading order)
                group_texts = []
                for group_blocks in layout_groups:
                    if group_blocks:
                        # Use XY-Cut within each group for fine-grained ordering
                        group_text = self._recursive_xy_cut(
                            group_blocks, page_width, page.rect.height, process_block_group
                        )
                        group_texts.append(group_text)
                return "\n\n".join(group_texts)
        
        # Fallback: Recursive XY Cut Algorithm
        return self._recursive_xy_cut(blocks, page_width, page.rect.height, process_block_group)

    def _get_image_size(self, image) -> tuple[float, float]:
        if hasattr(image, "shape") and len(image.shape) >= 2:
            return float(image.shape[1]), float(image.shape[0])
        if hasattr(image, "size"):
            size = image.size
            if isinstance(size, tuple) and len(size) >= 2:
                return float(size[0]), float(size[1])
        if isinstance(image, (tuple, list)) and len(image) >= 2:
            return float(image[0]), float(image[1])
        return 0.0, 0.0

    def _hierarchical_layout_clustering(self, blocks: list, page_width: float, page_height: float) -> list[list]:
        """
        Advanced layout detection with Column Stitching.
        1. Cluster by Y to get vertical strips.
        2. Within strips, detect horizontal segments.
        3. "Stitch" segments vertically into Columns.
        4. Detect layout changes (e.g. 1-col to 2-col) to split sections.
        Returns block groups in reading order (Sections top-down, Columns left-right).
        """
        if not blocks or not HAS_NUMPY:
            return [blocks]
        
        # 1. Cluster by Y (vertical position)
        y_centers = np.array([(b["bbox"][1] + b["bbox"][3]) / 2 for b in blocks]).reshape(-1, 1)
        # Use a smaller gap to be sensitive to structure, stitching will merge them back
        min_row_gap = page_height * 0.01 
        
        row_groups = self._cluster_by_axis(blocks, y_centers, min_row_gap, max_k=8)
        # Sort row groups by average Y
        row_groups.sort(key=lambda grp: np.mean([(b["bbox"][1] + b["bbox"][3]) / 2 for b in grp]))
        
        # 2. Process strips and build sections
        final_groups = []
        
        class Column:
            def __init__(self, segment):
                self.blocks = segment['blocks'][:]
                self.x0 = segment['x0']
                self.x1 = segment['x1']
            
            def add(self, segment):
                self.blocks.extend(segment['blocks'])
                # Update bounds (running average or expanding? Expanding is safer for alignment)
                self.x0 = min(self.x0, segment['x0'])
                self.x1 = max(self.x1, segment['x1'])
                
            def matches(self, segment):
                # Check Intersection over Union of X-range
                seg_w = segment['x1'] - segment['x0']
                col_w = self.x1 - self.x0
                
                inter_x0 = max(self.x0, segment['x0'])
                inter_x1 = min(self.x1, segment['x1'])
                inter = max(0, inter_x1 - inter_x0)
                
                union = (self.x1 - self.x0) + seg_w - inter
                
                if union <= 0: return False
                iou = inter / union
                
                # Match if high overlap OR significant containment
                # (Handle short lines within a column, or column within a wider header)
                containment = inter / min(seg_w, col_w) if min(seg_w, col_w) > 0 else 0
                
                return iou > 0.5 or containment > 0.9
            
            def overlaps(self, segment):
                # Check if they physically overlap in X
                inter_x0 = max(self.x0, segment['x0'])
                inter_x1 = min(self.x1, segment['x1'])
                return inter_x0 < inter_x1

        current_columns = [] # List of Column objects
        
        for row_blocks in row_groups:
            if not row_blocks: continue
            
            # X-Cluster this strip
            x_centers = np.array([(b["bbox"][0] + b["bbox"][2]) / 2 for b in row_blocks]).reshape(-1, 1)
            min_col_gap = page_width * 0.02
            col_segments_blocks = self._cluster_by_axis(row_blocks, x_centers, min_col_gap, max_k=4)
            
            # Create segment objects
            segments = []
            for seg_blocks in col_segments_blocks:
                x0 = min(b["bbox"][0] for b in seg_blocks)
                x1 = max(b["bbox"][2] for b in seg_blocks)
                segments.append({'blocks': seg_blocks, 'x0': x0, 'x1': x1})
            
            # Try to stitch segments to current columns
            layout_changed = False
            
            # Map segments to columns
            unmatched_segments = []
            
            for seg in segments:
                matched_col = None
                for col in current_columns:
                    if col.matches(seg):
                        matched_col = col
                        break
                
                if matched_col:
                    matched_col.add(seg)
                else:
                    unmatched_segments.append(seg)
                    
            # Check for layout change (Break Condition)
            # If an unmatched segment overlaps significantly with an existing column's space
            for seg in unmatched_segments:
                for col in current_columns:
                    if col.overlaps(seg):
                        # Verify it's not just a small sidebar interfering with main text
                        # If overlap is significant relative to segment or column
                        inter_x0 = max(col.x0, seg['x0'])
                        inter_x1 = min(col.x1, seg['x1'])
                        inter_w = inter_x1 - inter_x0
                        if inter_w > 10: # Significant physical overlap
                            # print(f"Layout break: Overlap detected. Col: {col.x0:.1f}-{col.x1:.1f}, Seg: {seg['x0']:.1f}-{seg['x1']:.1f}")
                            layout_changed = True
                            break
                if layout_changed: break
            
            if layout_changed:
                # Flush current section
                if current_columns:
                    # Sort columns Left-to-Right
                    current_columns.sort(key=lambda c: (c.x0 + c.x1)/2)
                    # print(f"Flushing section. Cols: {[(c.x0, c.x1) for c in current_columns]}")
                    for col in current_columns:
                        final_groups.append(col.blocks)
                
                # Start new section with current segments
                current_columns = [Column(s) for s in segments]
                
            else:
                # Add unmatched segments as new columns (e.g. sidebar appearing)
                for seg in unmatched_segments:
                    current_columns.append(Column(seg))
        
        # Flush final section
        if current_columns:
            current_columns.sort(key=lambda c: (c.x0 + c.x1)/2)
            # print(f"Flushing final. Cols: {[(c.x0, c.x1) for c in current_columns]}")
            for col in current_columns:
                final_groups.append(col.blocks)
                
        return final_groups if final_groups else [blocks]

    def _cluster_by_axis(self, blocks: list, values: 'np.ndarray', min_gap: float, max_k: int = 4) -> list[list]:
        """
        Generic 1D clustering helper.
        Clusters blocks based on a 1D value array (e.g., X or Y centers).
        """
        if len(blocks) < 2:
            return [blocks]
        
        # Simple clustering based on gaps
        # 1. Sort by value
        sorted_indices = np.argsort(values.flatten())
        sorted_values = values[sorted_indices]
        sorted_blocks = [blocks[i] for i in sorted_indices]
        
        # 2. Find gaps > min_gap
        groups = []
        current_group = [sorted_blocks[0]]
        
        for i in range(1, len(sorted_blocks)):
            gap = sorted_values[i][0] - sorted_values[i-1][0]
            if gap > min_gap:
                groups.append(current_group)
                current_group = []
            current_group.append(sorted_blocks[i])
        groups.append(current_group)
        
        return groups

    def _simple_kmeans(self, data: 'np.ndarray', k: int, max_iter: int = 50) -> tuple:
        """
        Simple K-means implementation without sklearn dependency.
        Returns (labels, centers) or (None, None) on failure.
        """
        n = len(data)
        if n < k:
            return None, None
        
        # Initialize centers using k-means++ style
        rng = np.random.default_rng(42)  # Fixed seed for reproducibility
        centers = np.zeros((k, 1))
        centers[0] = data[rng.integers(0, n)]
        
        for i in range(1, k):
            # Choose next center with probability proportional to distance squared
            dist_sq = np.min([np.sum((data - centers[j])**2, axis=1) for j in range(i)], axis=0)
            probs = dist_sq / dist_sq.sum()
            centers[i] = data[rng.choice(n, p=probs)]
        
        labels = np.zeros(n, dtype=int)
        
        for _ in range(max_iter):
            # Assign labels
            distances = np.array([np.sum((data - c)**2, axis=1) for c in centers])
            new_labels = np.argmin(distances, axis=0)
            
            if np.array_equal(labels, new_labels):
                break
            labels = new_labels
            
            # Update centers
            for i in range(k):
                mask = labels == i
                if np.any(mask):
                    centers[i] = data[mask].mean(axis=0)
        
        return labels, centers

    def _cluster_quality_score(self, data: 'np.ndarray', labels: 'np.ndarray', centers: 'np.ndarray') -> float:
        """
        Calculate a simple cluster quality score (higher is better).
        Based on ratio of between-cluster to within-cluster variance.
        """
        n = len(data)
        k = len(centers)
        
        if k <= 1 or n <= k:
            return 0.0
        
        # Within-cluster variance
        within = 0.0
        for i in range(k):
            mask = labels == i
            if np.any(mask):
                within += np.sum((data[mask] - centers[i])**2)
        
        # Between-cluster variance
        global_mean = data.mean()
        counts = np.array([np.sum(labels == i) for i in range(k)])
        between = np.sum(counts * (centers.flatten() - global_mean)**2)
        
        if within == 0:
            return float('inf') if between > 0 else 0.0
        
        return between / within

    def _filter_artifacts(self, words: list, page_width: float) -> list:
        """
        Filter out line numbers and other margin artifacts.
        Identifies vertical columns of small integer numbers in the margins.
        """
        if not words:
            return words
            
        # Candidates: small integers
        candidates = []
        for i, w in enumerate(words):
            text = w[4].strip()
            # Check if it looks like a line number (digits, length <= 4)
            if text.isdigit() and len(text) <= 4:
                candidates.append(i)
        
        if not candidates:
            return words
            
        # Group candidates by X-center
        # We look for "pillars" of numbers
        x_bins = {}
        bin_width = 10.0 # pixels
        
        # Define margin threshold (15%)
        left_margin = page_width * 0.15
        right_margin = page_width * 0.85

        for idx in candidates:
            w = words[idx]
            x_center = (w[0] + w[2]) / 2
            
            # CRITICAL: Only consider candidates in the margins
            # This prevents deleting integer columns in tables (usually distinct from margins)
            if left_margin < x_center < right_margin:
                continue
            
            bin_idx = int(x_center / bin_width)
            
            if bin_idx not in x_bins:
                x_bins[bin_idx] = []
            x_bins[bin_idx].append(idx)
            
        # Identify artifact bins
        # A valid line number column should have significant count (e.g., > 10 items)
        artifact_indices = set()
        
        for bin_idx, indices in x_bins.items():
            if len(indices) > 10:
                # Strong signal: This X-column is mostly numbers
                artifact_indices.update(indices)
                
        if not artifact_indices:
            return words
            
        # Filter
        filtered_words = [w for i, w in enumerate(words) if i not in artifact_indices]
        return filtered_words

    def _recursive_xy_cut(self, blocks: list, width: float, height: float, processor) -> str:
        """
        Recursively split blocks by Horizontal gaps (Y-axis) then Vertical gaps (X-axis).
        """
        if not blocks:
            return ""

        # 1. Try Horizontal Split (Rows)
        # Project to Y-axis
        y_intervals = [(b["bbox"][1], b["bbox"][3]) for b in blocks]
        y_gaps = self._find_gaps(y_intervals, 0, height, min_gap=5.0) # 5pt vertical gap minimum
        
        if y_gaps:
             # Split into rows
            rows = [[] for _ in range(len(y_gaps) + 1)]
            split_points = sorted([(g[0] + g[1])/2 for g in y_gaps])
            
            for b in blocks:
                # Assign based on Y-center
                cy = (b["bbox"][1] + b["bbox"][3]) / 2
                found = False
                for i, sp in enumerate(split_points):
                    if cy < sp:
                        rows[i].append(b)
                        found = True
                        break
                if not found:
                    rows[-1].append(b)
            
            # Recurse on each row (non-empty)
            parts = []
            for r in rows:
                if r:
                    parts.append(self._recursive_xy_cut(r, width, height, processor))
            return "\n\n".join(parts)

        # 2. Try Vertical Split (Columns)
        # Project to X-axis
        x_intervals = [(b["bbox"][0], b["bbox"][2]) for b in blocks]
        x_gaps = self._find_gaps(x_intervals, 0, width, min_gap=15.0) # 15pt horizontal gap (gutter)
        
        if x_gaps:
            # Split into cols
            cols = [[] for _ in range(len(x_gaps) + 1)]
            split_points = sorted([(g[0] + g[1])/2 for g in x_gaps])
            
            for b in blocks:
                # Assign based on X-center
                cx = (b["bbox"][0] + b["bbox"][2]) / 2
                found = False
                for i, sp in enumerate(split_points):
                    if cx < sp:
                        cols[i].append(b)
                        found = True
                        break
                if not found:
                    cols[-1].append(b)
            
            # Recurse on each column
            parts = []
            for c in cols:
                if c:
                    parts.append(self._recursive_xy_cut(c, width, height, processor))
            return "\n\n".join(parts)
            
        # 3. Leaf Node (No splits detected)
        return processor(blocks)

    def _find_gaps(self, intervals: list[tuple[float, float]], min_val: float, max_val: float, min_gap: float) -> list[tuple[float, float]]:
        """
        Find gaps in a set of intervals covering [min_val, max_val].
        Returns list of (start, end) tuples for gaps > min_gap.
        """
        # Sort by start time
        intervals.sort(key=lambda x: x[0])
        
        merged = []
        if not intervals:
            return [(min_val, max_val)] # Whole thing is a gap if no intervals? 
            # Actually if no blocks, we handled it earlier. But let's be safe.
        
        # Merge intervals to find coverage
        curr_start, curr_end = intervals[0]
        for start, end in intervals[1:]:
            if start < curr_end: # Overlap or touch
                curr_end = max(curr_end, end)
            else:
                merged.append((curr_start, curr_end))
                curr_start, curr_end = start, end
        merged.append((curr_start, curr_end))
        
        # Find gaps between merged intervals
        gaps = []
        
        # Check gap before first interval?
        # Usually checking margins is tricky. Layout usually cares about INTERNAL gaps.
        # But if we strictly want X-Y cut, we care about internal separators.
        
        prev_end = merged[0][1]
        for start, end in merged[1:]:
             gap_width = start - prev_end
             if gap_width > min_gap:
                 gaps.append((prev_end, start))
             prev_end = end
             
        return gaps

    def _words_to_text(self, words: list) -> str:
        """
        Convert list of words to structured text.
        Words: list of (x0, y0, x1, y1, text, ...)
        Steps:
        1. Group into Lines.
        2. Insert spaces.
        3. Merge lines to paragraphs (respecting vertical gaps).
        """
        if not words:
            return ""

        # 1. Group into lines
        lines_data = [] # List of {"words": [], "y_range": (y0, y1)}
        
        current_words = []
        current_y_range = None 

        for w in words:
            x0, y0, x1, y1, text = w[:5]
            
            if not current_words:
                current_words = [w]
                current_y_range = (y0, y1)
                continue
            
            cy0, cy1 = current_y_range
            
            # Check overlap logic
            # Calculate vertical intersection
            overlap_y0 = max(y0, cy0)
            overlap_y1 = min(y1, cy1)
            overlap_h = max(0, overlap_y1 - overlap_y0)
            
            min_h = min(y1 - y0, cy1 - cy0)
            
            # If overlap is significant (> 50% of the shorter word height), group as same line
            if min_h > 0 and (overlap_h / min_h) > 0.5:
                current_words.append(w)
                # Expand the line boundary
                current_y_range = (min(cy0, y0), max(cy1, y1))
            else:
                # Finish current line
                lines_data.append({"words": current_words, "y_range": current_y_range})
                # Start new line
                current_words = [w]
                current_y_range = (y0, y1)
                
        if current_words:
            lines_data.append({"words": current_words, "y_range": current_y_range})
            
        # 2. Process lines and check gaps
        processed_lines = [] # List of (text, is_gap_break)
        
        prev_y1 = None
        prev_height = None
        
        for line in lines_data:
            l_words = line["words"]
            text, avg_height = self._process_line_words(l_words)
            
            is_gap_break = False
            curr_y0, curr_y1 = line["y_range"]
            
            if prev_y1 is not None:
                gap = curr_y0 - prev_y1
                # If gap is significantly larger than previous line height (e.g., > 70%), assume paragraph break
                # Normal line spacing is usually 10-20% of height.
                # Double spacing is 100%. 
                threshold = prev_height * 0.7 if prev_height else 5.0
                if gap > threshold:
                    is_gap_break = True
            
            processed_lines.append((text, is_gap_break))
            
            prev_y1 = curr_y1
            prev_height = avg_height

        # 3. Merge lines into paragraphs
        return self._merge_lines_to_paragraphs(processed_lines)

    def _process_line_words(self, line_words: list) -> tuple[str, float]:
        """
        Sort words in X, add spaces.
        Returns: (text, avg_height)
        """
        # Sort by x0
        line_words.sort(key=lambda w: w[0])
        
        if not line_words:
            return "", 0.0
            
        out_str = []
        prev_x1 = None
        
        # Estimate font size (height)
        heights = [w[3]-w[1] for w in line_words]
        avg_height = sum(heights) / len(heights) if heights else 10.0
        
        # Threshold for spacing: 10% of font height
        space_threshold = avg_height * 0.1
        
        for w in line_words:
            x0, y0, x1, y1, text = w[:5]
            
            if prev_x1 is not None:
                gap = x0 - prev_x1
                if gap > space_threshold:
                    out_str.append(" ")
            
            out_str.append(text)
            prev_x1 = x1
            
        return "".join(out_str), avg_height
        
    def _merge_lines_to_paragraphs(self, lines: list[tuple[str, bool]]) -> str:
        """
        Heuristic method to merge lines.
        Input: list of (line_text, is_gap_break).
        Output: single string with \\n\\n for paragraphs.
        """
        if not lines:
            return ""
            
        final_paragraphs = []
        # Buffer holds the current paragraph text being built
        buffer = lines[0][0].strip()
        
        for i in range(1, len(lines)):
            line, is_gap_break = lines[i]
            line = line.strip()
            if not line:
                continue
            
            prev_char = buffer[-1] if buffer else ""
            
            # If explicit gap break detected, force new paragraph
            if is_gap_break:
                final_paragraphs.append(buffer)
                buffer = line
                continue
            
            # Rule 1: Hyphenation
            if prev_char == "-":
                buffer = buffer[:-1] + line
                continue
                
            # Rule 2: Sentence continuity
            ends_with_stop = prev_char in ".!?"
            starts_lowercase = line[0].islower() if line else False
            
            # Merge if: It's NOT a stop OR it continues with lowercase
            should_merge = (not ends_with_stop) or starts_lowercase
            
            if should_merge:
                buffer += " " + line
            else:
                final_paragraphs.append(buffer)
                buffer = line
                
        if buffer:
            final_paragraphs.append(buffer)
            
        return "\n\n".join(final_paragraphs)
