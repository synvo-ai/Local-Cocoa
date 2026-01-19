#!/usr/bin/env python3
import sys
import time
import argparse
import logging
from pathlib import Path
from datetime import timedelta

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).parent.parent.absolute()
sys.path.append(str(PROJECT_ROOT))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)


def _estimate_white_block_ratio(
    page,
    exclude_boxes: list[tuple[float, float, float, float]] | None = None,
    max_dim: int = 800,
    white_thresh: int = 245,
    min_block_ratio: float = 0.01,
) -> float:
    """Estimate large white-block area ratio using connected components on a downsampled page render."""
    try:
        import numpy as np  # type: ignore
    except ImportError:
        return 0.0

    try:
        import fitz  # PyMuPDF
    except ImportError:
        return 0.0

    page_width = page.rect.width
    page_height = page.rect.height
    if page_width <= 0 or page_height <= 0:
        return 0.0

    scale = min(1.0, max_dim / max(page_width, page_height))
    matrix = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    if pix.width <= 0 or pix.height <= 0:
        return 0.0

    data = np.frombuffer(pix.samples, dtype=np.uint8)
    channels = pix.n
    if channels <= 0:
        return 0.0

    data = data.reshape((pix.height, pix.width, channels))
    if channels >= 3:
        rgb = data[:, :, :3]
    else:
        rgb = np.repeat(data[:, :, :1], 3, axis=2)

    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    white_mask = lum >= white_thresh
    exclude_mask = np.zeros_like(white_mask, dtype=bool)

    if exclude_boxes:
        sx = pix.width / page_width
        sy = pix.height / page_height
        for x0, y0, x1, y1 in exclude_boxes:
            px0 = int(max(0, min(pix.width, x0 * sx)))
            py0 = int(max(0, min(pix.height, y0 * sy)))
            px1 = int(max(0, min(pix.width, x1 * sx)))
            py1 = int(max(0, min(pix.height, y1 * sy)))
            if px1 <= px0 or py1 <= py0:
                continue
            exclude_mask[py0:py1, px0:px1] = True

    total_pixels = white_mask.size
    if total_pixels == 0:
        return 0.0

    min_block_size = int(total_pixels * min_block_ratio)
    visited = np.zeros_like(white_mask, dtype=bool)
    white_block_pixels = 0

    height, width = white_mask.shape
    for y in range(height):
        for x in range(width):
            if not white_mask[y, x] or visited[y, x]:
                continue
            stack = [(y, x)]
            visited[y, x] = True
            count = 0
            overlap_count = 0
            while stack:
                cy, cx = stack.pop()
                count += 1
                if exclude_mask[cy, cx]:
                    overlap_count += 1
                if cy > 0 and white_mask[cy - 1, cx] and not visited[cy - 1, cx]:
                    visited[cy - 1, cx] = True
                    stack.append((cy - 1, cx))
                if cy + 1 < height and white_mask[cy + 1, cx] and not visited[cy + 1, cx]:
                    visited[cy + 1, cx] = True
                    stack.append((cy + 1, cx))
                if cx > 0 and white_mask[cy, cx - 1] and not visited[cy, cx - 1]:
                    visited[cy, cx - 1] = True
                    stack.append((cy, cx - 1))
                if cx + 1 < width and white_mask[cy, cx + 1] and not visited[cy, cx + 1]:
                    visited[cy, cx + 1] = True
                    stack.append((cy, cx + 1))

            if count >= min_block_size:
                white_block_pixels += max(0, count - overlap_count)

    return white_block_pixels / total_pixels


def _is_nearly_uniform_image(pix, max_samples: int = 10000) -> bool:
    """Return True if image is mostly white or near-uniform."""
    try:
        import numpy as np  # type: ignore
        has_numpy = True
    except ImportError:
        np = None
        has_numpy = False

    samples = pix.samples
    channels = pix.n
    total_pixels = pix.width * pix.height
    if total_pixels <= 0 or channels <= 0:
        return False

    if has_numpy:
        data = np.frombuffer(samples, dtype=np.uint8)
        data = data.reshape((-1, channels))
        if channels >= 3:
            rgb = data[:, :3]
        else:
            rgb = np.repeat(data[:, :1], 3, axis=1)
        step = max(1, len(rgb) // max_samples)
        rgb = rgb[::step]
        lum = 0.2126 * rgb[:, 0] + 0.7152 * rgb[:, 1] + 0.0722 * rgb[:, 2]
        white_ratio = float(np.mean(lum >= 245))
        std = float(np.std(lum))
        return white_ratio >= 0.98 or std <= 5.0

    # Fallback without numpy (sampled luminance)
    step = max(1, total_pixels // max_samples)
    lum_values = []
    for idx in range(0, total_pixels, step):
        offset = idx * channels
        if offset + channels > len(samples):
            break
        if channels >= 3:
            r = samples[offset]
            g = samples[offset + 1]
            b = samples[offset + 2]
        else:
            r = g = b = samples[offset]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        lum_values.append(lum)
        if len(lum_values) >= max_samples:
            break

    if not lum_values:
        return False

    avg = sum(lum_values) / len(lum_values)
    var = sum((v - avg) ** 2 for v in lum_values) / len(lum_values)
    std = var ** 0.5
    white_ratio = sum(1 for v in lum_values if v >= 245) / len(lum_values)
    return white_ratio >= 0.98 or std <= 5.0


def _group_overlapping_figures(figures: list, page_width: float, page_height: float) -> list[list]:
    """
    Group overlapping figures together using Union-Find.
    Returns list of groups, each group is a list of figure dicts.
    
    This helps detect:
    1. Multi-part screenshots that were split
    2. Overlapping image artifacts
    3. Stacked figure elements
    """
    if not figures:
        return []
    
    n = len(figures)
    parent = list(range(n))
    
    def find(x):
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]
    
    def union(x, y):
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py
    
    def boxes_overlap(b1, b2, threshold=0.1):
        """Check if two bboxes overlap significantly."""
        x0_1, y0_1, x1_1, y1_1 = b1
        x0_2, y0_2, x1_2, y1_2 = b2
        
        # Calculate intersection
        inter_x0 = max(x0_1, x0_2)
        inter_y0 = max(y0_1, y0_2)
        inter_x1 = min(x1_1, x1_2)
        inter_y1 = min(y1_1, y1_2)
        
        if inter_x0 >= inter_x1 or inter_y0 >= inter_y1:
            return False
        
        inter_area = (inter_x1 - inter_x0) * (inter_y1 - inter_y0)
        area1 = (x1_1 - x0_1) * (y1_1 - y0_1)
        area2 = (x1_2 - x0_2) * (y1_2 - y0_2)
        min_area = min(area1, area2)
        
        # Overlap if intersection is > threshold of smaller box
        return (inter_area / min_area) > threshold if min_area > 0 else False
    
    # Build groups by checking pairwise overlap
    for i in range(n):
        for j in range(i + 1, n):
            if boxes_overlap(figures[i]['bbox'], figures[j]['bbox']):
                union(i, j)
    
    # Collect groups
    groups_map = {}
    for i in range(n):
        root = find(i)
        if root not in groups_map:
            groups_map[root] = []
        groups_map[root].append(figures[i])
    
    return list(groups_map.values())


def visualize_layout(file_path: Path, output_path: Path, max_pages_per_image: int = 25):
    """
    Generate a layout visualization PNG showing bounding boxes for each page.
    Each page is rendered as a row with blocks numbered in reading order.
    
    For large PDFs (> max_pages_per_image), multiple images are generated:
    - output.layout.png (pages 1-40)
    - output.layout_2.png (pages 41-80)
    - etc.
    """
    try:
        import fitz  # PyMuPDF
        import matplotlib.pyplot as plt
        import matplotlib.patches as patches
        import numpy as np
    except ImportError as e:
        logger.error(f"Visualization requires matplotlib and PyMuPDF: {e}")
        return
    
    from services.parser.pdf import PdfParser, HAS_NUMPY
    
    doc = fitz.open(str(file_path))
    num_pages = len(doc)
    
    if num_pages == 0:
        logger.error("PDF has no pages")
        doc.close()
        return
    
    # For large PDFs, split into multiple images
    num_parts = (num_pages + max_pages_per_image - 1) // max_pages_per_image
    
    for part_idx in range(num_parts):
        start_page = part_idx * max_pages_per_image
        end_page = min((part_idx + 1) * max_pages_per_image, num_pages)
        pages_in_part = end_page - start_page
        
        # Generate output path for this part
        if num_parts == 1:
            part_output = output_path
        else:
            stem = output_path.stem.replace('.layout', '')
            part_output = output_path.parent / f"{stem}.layout_{part_idx + 1}.png"
        
        _visualize_pages(doc, start_page, end_page, part_output)
        
        if num_parts > 1:
            logger.info(f"Layout visualization saved to: {part_output} (pages {start_page+1}-{end_page})")
        else:
            logger.info(f"Layout visualization saved to: {part_output}")
    
    doc.close()


def _visualize_pages(doc, start_page: int, end_page: int, output_path: Path):
    """
    Internal function to visualize a range of pages.
    """
    import matplotlib.pyplot as plt
    import matplotlib.patches as patches
    
    from services.parser.pdf import PdfParser, HAS_NUMPY
    
    pages_in_part = end_page - start_page
    
    # Create figure with one row per page
    fig_height = max(4, pages_in_part * 3)  # 3 inches per page
    fig, axes = plt.subplots(pages_in_part, 1, figsize=(10, fig_height))
    
    # Handle single page case
    if pages_in_part == 1:
        axes = [axes]
    
    # Colors for different columns
    column_colors = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f39c12']
    
    pdf_parser = PdfParser()
    
    for local_idx, page_idx in enumerate(range(start_page, end_page)):
        page = doc[page_idx]
        ax = axes[local_idx]
        
        # Get page dimensions
        page_width = page.rect.width
        page_height = page.rect.height
        
        # Set up axis
        ax.set_xlim(0, page_width)
        ax.set_ylim(page_height, 0)  # Invert Y for PDF coordinates
        ax.set_aspect('equal')
        ax.set_title(f'Page {page_idx + 1}', fontsize=10, fontweight='bold')  # page_idx is 0-based, so +1 for display
        ax.set_facecolor('#f5f5f5')
        ax.axis('off')  # Hide x and y axis
        
        # === Figure Detection (with filtering for full-page scans and out-of-bounds) ===
        figure_count = 0
        scan_page = False  # Flag if this page is a full-page scan/screenshot
        page_area = page_width * page_height
        img_boxes: list[tuple[float, float, float, float]] = []
        icon_boxes: list[tuple[float, float, float, float]] = []
        
        img_area_total = 0.0
        try:
            images = page.get_images(full=True)
            valid_figures = []  # Collect valid figures for potential grouping
            
            for img in images:
                xref = img[0]
                # Get image bbox
                for img_rect in page.get_image_rects(xref):
                    x0, y0, x1, y1 = img_rect
                    
                    # 1. Filter out-of-bounds images (fully outside page)
                    if x1 <= 0 or y1 <= 0 or x0 >= page_width or y0 >= page_height:
                        continue
                    
                    # 2. Clip to page bounds for area calculation
                    clipped_x0 = max(0, x0)
                    clipped_y0 = max(0, y0)
                    clipped_x1 = min(page_width, x1)
                    clipped_y1 = min(page_height, y1)
                    
                    img_width = clipped_x1 - clipped_x0
                    img_height = clipped_y1 - clipped_y0
                    img_area = img_width * img_height
                    
                    # 3. Filter out small artifacts/logos (< 30x30)
                    # Treat them as icons for white-block exclusion, but not as figures.
                    if img_width < 30 or img_height < 30:
                        icon_boxes.append((clipped_x0, clipped_y0, clipped_x1, clipped_y1))
                        continue
                    
                    # Skip near-uniform images (e.g., blank/solid backgrounds)
                    try:
                        pix = fitz.Pixmap(doc, xref)
                        if pix.alpha:
                            pix = fitz.Pixmap(pix, 0)
                        if _is_nearly_uniform_image(pix):
                            pix = None
                            continue
                        pix = None
                    except Exception:
                        pass

                    # 4. Check if this is a full-page scan/screenshot (covers > 70% of page)
                    coverage_ratio = img_area / page_area if page_area > 0 else 0
                    
                    if coverage_ratio > 0.70:
                        # This is likely a full-page scan, mark page but don't draw as Fig
                        scan_page = True
                        img_area_total += img_area
                        img_boxes.append((clipped_x0, clipped_y0, clipped_x1, clipped_y1))
                        # Draw as background indicator (dashed border)
                        rect = patches.Rectangle(
                            (clipped_x0, clipped_y0), img_width, img_height,
                            linewidth=2, linestyle=':',
                            edgecolor='#95a5a6',  # Gray for scan/background
                            facecolor='#95a5a6',
                            alpha=0.1
                        )
                        ax.add_patch(rect)
                        ax.text(page_width/2, 20, 'Scan/BG', fontsize=9, color='#95a5a6',
                               ha='center', fontweight='bold',
                               bbox=dict(boxstyle='round,pad=0.3', facecolor='white', alpha=0.9))
                    else:
                        # Valid figure - collect for later analysis
                        valid_figures.append({
                            'bbox': (clipped_x0, clipped_y0, clipped_x1, clipped_y1),
                            'original': (x0, y0, x1, y1),
                            'area': img_area
                        })
                        img_area_total += img_area
                        img_boxes.append((clipped_x0, clipped_y0, clipped_x1, clipped_y1))
            
            # 5. Group overlapping figures to detect multi-part screenshots
            if valid_figures:
                figure_groups = _group_overlapping_figures(valid_figures, page_width, page_height)
                
                for group in figure_groups:
                    if len(group) > 3:
                        # Many overlapping figures - likely a screenshot split or artifact
                        # Draw as a single grouped region
                        group_x0 = min(f['bbox'][0] for f in group)
                        group_y0 = min(f['bbox'][1] for f in group)
                        group_x1 = max(f['bbox'][2] for f in group)
                        group_y1 = max(f['bbox'][3] for f in group)
                        
                        rect = patches.Rectangle(
                            (group_x0, group_y0), group_x1 - group_x0, group_y1 - group_y0,
                            linewidth=2, linestyle='--',
                            edgecolor='#e74c3c',  # Red for grouped/problematic
                            facecolor='#e74c3c',
                            alpha=0.15
                        )
                        ax.add_patch(rect)
                        figure_count += 1
                        ax.text(group_x0 + 3, group_y0 + 12, f'Fig×{len(group)}', 
                               fontsize=7, color='#e74c3c',
                               bbox=dict(boxstyle='round,pad=0.2', facecolor='white', alpha=0.8))
                    else:
                        # Draw individual figures
                        for fig in group:
                            x0, y0, x1, y1 = fig['bbox']
                            rect = patches.Rectangle(
                                (x0, y0), x1 - x0, y1 - y0,
                                linewidth=2, linestyle='--',
                                edgecolor='#9b59b6',  # Purple for figures
                                facecolor='#9b59b6',
                                alpha=0.15
                            )
                            ax.add_patch(rect)
                            figure_count += 1
                            ax.text(x0 + 3, y0 + 12, f'Fig', fontsize=7, color='#9b59b6',
                                   bbox=dict(boxstyle='round,pad=0.2', facecolor='white', alpha=0.8))
                            
        except Exception:
            pass  # Some PDFs may not support image extraction
        
        # === Table Detection ===
        table_count = 0
        table_boxes: list[tuple[float, float, float, float]] = []
        try:
            tables = page.find_tables()
            for table in tables:
                bbox = table.bbox
                x0, y0, x1, y1 = bbox
                rect = patches.Rectangle(
                    (x0, y0), x1 - x0, y1 - y0,
                    linewidth=2, linestyle=':',
                    edgecolor='#e67e22',  # Orange for tables
                    facecolor='#e67e22',
                    alpha=0.15
                )
                ax.add_patch(rect)
                table_count += 1
                table_boxes.append((x0, y0, x1, y1))
                ax.text(x0 + 3, y0 + 12, f'Tbl', fontsize=7, color='#e67e22',
                       bbox=dict(boxstyle='round,pad=0.2', facecolor='white', alpha=0.8))
        except Exception:
            pass  # Table detection may not be available in all PyMuPDF versions
        
        # === Text Block Detection ===
        words = page.get_text("words")
        if not words:
            ax.text(page_width/2, page_height/2, "No text", ha='center', va='center', fontsize=12)
            continue
        
        words = pdf_parser._filter_artifacts(words, page_width)
        
        # Group words by block
        blocks_map = {}
        for w in words:
            x0, y0, x1, y1, text, block_no, line_no, word_no = w
            if block_no not in blocks_map:
                blocks_map[block_no] = {
                    "words": [],
                    "bbox": [x0, y0, x1, y1]
                }
            b = blocks_map[block_no]
            b["words"].append(w)
            b["bbox"][0] = min(b["bbox"][0], x0)
            b["bbox"][1] = min(b["bbox"][1], y0)
            b["bbox"][2] = max(b["bbox"][2], x1)
            b["bbox"][3] = max(b["bbox"][3], y1)
        
        blocks = list(blocks_map.values())
        text_boxes = [tuple(block["bbox"]) for block in blocks]
        exclude_boxes = text_boxes + img_boxes + table_boxes + icon_boxes
        white_block_ratio = _estimate_white_block_ratio(page, exclude_boxes=exclude_boxes)
        effective_page_area = page_area * (1.0 - white_block_ratio)
        if effective_page_area <= 0:
            effective_page_area = page_area

        # Use hierarchical Y-X clustering
        if HAS_NUMPY and len(blocks) >= 3:
            layout_groups = pdf_parser._hierarchical_layout_clustering(blocks, page_width, page_height)
        else:
            layout_groups = [blocks]

        # Text coverage ratio (text + tables within effective area)
        text_area = 0.0
        for x0, y0, x1, y1 in text_boxes + table_boxes:
            text_area += max(0, x1 - x0) * max(0, y1 - y0)
        text_ratio = (text_area / effective_page_area) if effective_page_area > 0 else 0.0
        img_ratio = (img_area_total / effective_page_area) if effective_page_area > 0 else 0.0
        if text_ratio < 0:
            text_ratio = 0.0
        if img_ratio < 0:
            img_ratio = 0.0
        if text_ratio > 1.0:
            text_ratio = 1.0
        if img_ratio > 1.0:
            img_ratio = 1.0

        # Draw blocks with group colors and order numbers
        block_order = 0
        for group_idx, group_blocks in enumerate(layout_groups):
            color = column_colors[group_idx % len(column_colors)]
            
            # Sort blocks within group by Y position (already sorted by hierarchical clustering)
            group_blocks_sorted = sorted(group_blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))
            
            for block in group_blocks_sorted:
                x0, y0, x1, y1 = block["bbox"]
                width = x1 - x0
                height = y1 - y0
                
                # Draw rectangle
                rect = patches.Rectangle(
                    (x0, y0), width, height,
                    linewidth=1.5,
                    edgecolor=color,
                    facecolor=color,
                    alpha=0.2
                )
                ax.add_patch(rect)
                
                # Add order number
                block_order += 1
                ax.text(
                    x0 + 3, y0 + 12, 
                    str(block_order),
                    fontsize=8,
                    fontweight='bold',
                    color=color,
                    bbox=dict(boxstyle='round,pad=0.2', facecolor='white', alpha=0.8)
                )
        
        # Add legend
        legend_parts = [f"Groups: {len(layout_groups)}"]
        if figure_count > 0:
            legend_parts.append(f"Figs: {figure_count}")
        if table_count > 0:
            legend_parts.append(f"Tbls: {table_count}")
        if scan_page:
            legend_parts.append("📷 Scan")
        legend_parts.append(f"Text: {text_ratio * 100:.1f}%")
        legend_parts.append(f"Img: {img_ratio * 100:.1f}%")
        if white_block_ratio > 0:
            legend_parts.append(f"White: {white_block_ratio * 100:.1f}%")
        legend_text = " | ".join(legend_parts)
        ax.text(
            5, 15, legend_text,
            fontsize=8,
            bbox=dict(boxstyle='round', facecolor='white', alpha=0.9)
        )
        
        # Draw page border
        ax.add_patch(patches.Rectangle(
            (0, 0), page_width, page_height,
            linewidth=2, edgecolor='black', facecolor='none'
        ))
    
    try:
        plt.tight_layout()
    except Exception:
        pass  # tight_layout may fail for some configurations
    plt.savefig(output_path, dpi=100, facecolor='white')  # Lower DPI and no bbox_inches='tight' for stability
    plt.close()


def process_single_file(file_path: Path, output_path: Path, visualize: bool = False, quiet: bool = False):
    """
    Process a single PDF file and generate output.
    
    Args:
        file_path: Path to the PDF file
        output_path: Path to save the output text file
        visualize: Whether to generate layout visualization PNG
        quiet: If True, reduce console output (for batch mode)
    
    Returns:
        dict with processing stats, or None on error
    """
    # Buffer for output
    output_lines = []
    
    def log_and_print(msg):
        if not quiet:
            print(msg)
        output_lines.append(str(msg))

    try:
        # Import services here to catch import errors cleanly
        from services.parser.pdf import PdfParser
        try:
            from services.chunker.pipeline import ChunkingPipeline
        except ImportError:
            ChunkingPipeline = None
            if not quiet:
                logger.warning("ChunkingPipeline not available (missing dependencies?). Skipping chunking step.")
        
        # Initialize
        if not quiet:
            logger.info(f"Processing file: {file_path}")
            logger.info(f"Output will be saved to: {output_path}")
            logger.info("-" * 50)
        
        start_time = time.time()
        
        # 1. Parsing (OCR / Extraction)
        if not quiet:
            logger.info("Step 1: Parsing PDF (OCR/Text Extraction)...")
        pdf_parser = PdfParser()
        parsed_content = pdf_parser.parse(file_path)
        
        parse_time = time.time()
        
        if not quiet:
            logger.info(f"Parsing completed in {parse_time - start_time:.4f}s")
            logger.info(f"Detected Pages: {parsed_content.page_count}")
            logger.info(f"Total Text Length: {len(parsed_content.text)} chars")
        
        # Record timing info will be added after chunking is complete
        # Placeholder for summary position
        summary_insert_index = len(output_lines)
        
        log_and_print("\n--- Full Extracted Text (Page by Page) ---")
        if parsed_content.page_mapping:
            for start, end, page_num in parsed_content.page_mapping:
                page_text = parsed_content.text[start:end]
                log_and_print(f"--- Page {page_num} ({len(page_text)} chars) ---")
                log_and_print(page_text)
                log_and_print("-" * 30 + "\n")
        else:
            log_and_print("No page mapping defined. Showing full text:")
            log_and_print(parsed_content.text)
        log_and_print("--- End Full Text ---\n")

        # 2. Chunking
        if not quiet:
            logger.info("Step 2: Chunking...")
        
        # Use default settings or customizable via env vars
        chunks = []
        if ChunkingPipeline:
            pipeline = ChunkingPipeline()
            chunks = pipeline.build(
                file_id="test_file",
                text=parsed_content.text,
                page_mapping=parsed_content.page_mapping
            )
        elif not quiet:
            logger.warning("Skipping chunking because ChunkingPipeline is unavailable.")
        
        end_time = time.time()
        chunk_time = end_time - parse_time
        total_time = end_time - start_time
        
        if not quiet:
            logger.info(f"Chunking completed in {chunk_time:.4f}s")
            logger.info("-" * 50)
            logger.info(f"Total Processing Time: {total_time:.4f}s")
            logger.info(f"Total Chunks Generated: {len(chunks)}")
        
        # Insert timing summary at the beginning of output
        summary_lines = [
            "--- Processing Summary ---",
            f"File: {file_path.name}",
            f"Pages: {parsed_content.page_count}",
            f"Total Text: {len(parsed_content.text)} chars",
            f"Total Chunks: {len(chunks)}",
            f"Parse Time: {parse_time - start_time:.4f}s",
            f"Chunk Time: {chunk_time:.4f}s",
            f"Total OCR+Chunk Time: {total_time:.4f}s",
            "-" * 50,
            ""
        ]
        # Insert at the beginning
        for i, line in enumerate(summary_lines):
            output_lines.insert(summary_insert_index + i, line)
        
        log_and_print("\n--- Chunk Results ---")
        for i, chunk in enumerate(chunks):
            # Format metadata display
            pg_info = ""
            if chunk.metadata and "page_numbers" in chunk.metadata:
                pgs = chunk.metadata["page_numbers"]
                pg_info = f" [Pages: {pgs}]"
            
            log_and_print(f"[{i}] Tokens: {chunk.token_count} | Chars: {chunk.char_count}{pg_info}")
            log_and_print(f"Snippet: {chunk.snippet.replace(chr(10), ' ')[:100]}...") # Single line snippet
            log_and_print("-" * 20)
            log_and_print(f"Full Content:\n{chunk.text}\n")
            log_and_print("=" * 40)

        # Write to file
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(output_lines))
        if not quiet:
            logger.info(f"Results saved to {output_path}")
        
        # Generate layout visualization AFTER processing (not counted in timing)
        if visualize:
            viz_output = output_path.with_suffix('.layout.png')
            visualize_layout(file_path, viz_output)
        
        return {
            "file": file_path.name,
            "pages": parsed_content.page_count,
            "chars": len(parsed_content.text),
            "chunks": len(chunks),
            "parse_time": parse_time - start_time,
            "chunk_time": chunk_time,
            "total_time": total_time,
        }
            
    except ImportError as e:
        logger.error(f"Import Error: {e}")
        logger.error("Make sure you are running this from the project root and dependencies are installed.")
        return None
    except Exception as e:
        logger.error(f"An error occurred processing {file_path}: {e}")
        import traceback
        traceback.print_exc()
        return None


def process_directory(dir_path: Path, output_dir: Path, visualize: bool = False):
    """
    Process all PDF files in a directory.
    
    Args:
        dir_path: Path to the directory containing PDF files
        output_dir: Path to the output directory
        visualize: Whether to generate layout visualization PNGs
    """
    pdf_files = sorted(dir_path.glob("*.pdf"))
    
    if not pdf_files:
        logger.error(f"No PDF files found in {dir_path}")
        return
    
    logger.info(f"Found {len(pdf_files)} PDF files in {dir_path}")
    logger.info(f"Output will be saved to: {output_dir}")
    logger.info("=" * 60)
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    results = []
    failed = []
    
    for i, pdf_file in enumerate(pdf_files, 1):
        # Generate output path: same name but .txt extension
        output_path = output_dir / (pdf_file.stem + ".txt")
        
        logger.info(f"[{i}/{len(pdf_files)}] Processing: {pdf_file.name}")
        
        result = process_single_file(pdf_file, output_path, visualize=visualize, quiet=True)
        
        if result:
            results.append(result)
            logger.info(f"  ✓ {result['pages']} pages, {result['chars']} chars, {result['total_time']:.2f}s")
        else:
            failed.append(pdf_file.name)
            logger.error(f"  ✗ Failed to process")
    
    # Print summary
    logger.info("=" * 60)
    logger.info("BATCH PROCESSING COMPLETE")
    logger.info(f"  Processed: {len(results)}/{len(pdf_files)} files")
    if failed:
        logger.info(f"  Failed: {len(failed)} files")
        for f in failed:
            logger.info(f"    - {f}")
    
    total_pages = sum(r['pages'] for r in results)
    total_chars = sum(r['chars'] for r in results)
    total_time = sum(r['total_time'] for r in results)
    
    logger.info(f"  Total pages: {total_pages}")
    logger.info(f"  Total chars: {total_chars:,}")
    logger.info(f"  Total time: {total_time:.2f}s")
    
    # Write batch summary
    summary_path = output_dir / "_batch_summary.txt"
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(f"Batch Processing Summary\n")
        f.write(f"========================\n\n")
        f.write(f"Source: {dir_path}\n")
        f.write(f"Output: {output_dir}\n")
        f.write(f"Files processed: {len(results)}/{len(pdf_files)}\n\n")
        f.write(f"{'File':<50} {'Pages':>6} {'Chars':>10} {'Time':>8}\n")
        f.write("-" * 76 + "\n")
        for r in results:
            f.write(f"{r['file'][:48]:<50} {r['pages']:>6} {r['chars']:>10,} {r['total_time']:>7.2f}s\n")
        f.write("-" * 76 + "\n")
        f.write(f"{'TOTAL':<50} {total_pages:>6} {total_chars:>10,} {total_time:>7.2f}s\n")
        if failed:
            f.write(f"\nFailed files:\n")
            for ff in failed:
                f.write(f"  - {ff}\n")
    
    logger.info(f"  Summary saved to: {summary_path}")


def main():
    parser = argparse.ArgumentParser(description="Test OCR and Chunking pipeline performance (directory mode).")
    parser.add_argument("path", type=str, help="Path to a directory of PDFs")
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        default=None,
        help="Output base directory. A subfolder named after the input directory will be created. Default: logs/",
    )
    parser.add_argument("-v", "--visualize", action="store_true", help="Generate layout visualization PNG")
    args = parser.parse_args()

    input_path = Path(args.path)

    if not input_path.exists():
        logger.error(f"Path not found: {input_path}")
        sys.exit(1)

    if not input_path.is_dir():
        logger.error(f"Expected a directory path, got a file: {input_path}")
        sys.exit(1)

    if args.output:
        output_base = Path(args.output) if Path(args.output).is_absolute() else PROJECT_ROOT / args.output
    else:
        output_base = PROJECT_ROOT / "logs"

    output_dir = output_base / input_path.name
    process_directory(input_path, output_dir, visualize=args.visualize)


if __name__ == "__main__":
    main()
