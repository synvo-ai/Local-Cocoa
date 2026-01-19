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


def visualize_layout(file_path: Path, output_path: Path):
    """
    Generate a layout visualization PNG showing bounding boxes for each page.
    Each page is rendered as a row with blocks numbered in reading order.
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
    
    # Create figure with one row per page
    fig_height = max(4, num_pages * 3)  # 3 inches per page
    fig, axes = plt.subplots(num_pages, 1, figsize=(10, fig_height))
    
    # Handle single page case
    if num_pages == 1:
        axes = [axes]
    
    # Colors for different columns
    column_colors = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f39c12']
    
    pdf_parser = PdfParser()
    
    for page_idx, page in enumerate(doc):
        ax = axes[page_idx]
        
        # Get page dimensions
        page_width = page.rect.width
        page_height = page.rect.height
        
        # Set up axis
        ax.set_xlim(0, page_width)
        ax.set_ylim(page_height, 0)  # Invert Y for PDF coordinates
        ax.set_aspect('equal')
        ax.set_title(f'Page {page_idx + 1}', fontsize=10, fontweight='bold')
        ax.set_facecolor('#f5f5f5')
        ax.axis('off')  # Hide x and y axis
        
        # === Figure Detection ===
        figure_count = 0
        try:
            images = page.get_images(full=True)
            for img in images:
                xref = img[0]
                # Get image bbox
                for img_rect in page.get_image_rects(xref):
                    x0, y0, x1, y1 = img_rect
                    
                    # Filter out small artifacts/logos (e.g. < 50x50 area)
                    if (x1 - x0) < 30 or (y1 - y0) < 30:
                        continue
                        
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
        
        # Use hierarchical Y-X clustering
        if HAS_NUMPY and len(blocks) >= 3:
            layout_groups = pdf_parser._hierarchical_layout_clustering(blocks, page_width, page_height)
        else:
            layout_groups = [blocks]
        
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
    
    doc.close()
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight', facecolor='white')
    plt.close()
    
    logger.info(f"Layout visualization saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Test OCR and Chunking pipeline performance.")
    parser.add_argument("file_path", type=str, help="Path to the PDF file to process")
    parser.add_argument("-o", "--output", type=str, default="logs/ocr_test_result.txt", help="Path to save the output text file (default: logs/ocr_test_result.txt)")
    parser.add_argument("-v", "--visualize", action="store_true", help="Generate layout visualization PNG")
    args = parser.parse_args()

    file_path = Path(args.file_path)
    # Ensure relative paths are handled correctly from project root context
    if not Path(args.output).is_absolute():
        output_path = PROJECT_ROOT / args.output
    else:
        output_path = Path(args.output)
    
    # Create parent directory if it doesn't exist
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not file_path.exists():
        logger.error(f"File not found: {file_path}")
        sys.exit(1)

    # Buffer for output
    output_lines = []
    
    def log_and_print(msg):
        print(msg)
        output_lines.append(str(msg))

    try:
        # Import services here to catch import errors cleanly
        from services.parser.pdf import PdfParser
        try:
            from services.chunker.pipeline import ChunkingPipeline
        except ImportError:
            ChunkingPipeline = None
            logger.warning("ChunkingPipeline not available (missing dependencies?). Skipping chunking step.")
        
        # Initialize
        logger.info(f"Processing file: {file_path}")
        logger.info(f"Output will be saved to: {output_path}")
        logger.info("-" * 50)
        
        start_time = time.time()
        
        # 1. Parsing (OCR / Extraction)
        logger.info("Step 1: Parsing PDF (OCR/Text Extraction)...")
        pdf_parser = PdfParser()
        parsed_content = pdf_parser.parse(file_path)
        
        parse_time = time.time()
        
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
        else:
             logger.warning("Skipping chunking because ChunkingPipeline is unavailable.")
        
        end_time = time.time()
        chunk_time = end_time - parse_time
        total_time = end_time - start_time
        
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
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(output_lines))
        logger.info(f"Results saved to {output_path}")
        
        # Generate layout visualization AFTER processing (not counted in timing)
        if args.visualize:
            viz_output = output_path.with_suffix('.layout.png')
            visualize_layout(file_path, viz_output)
            
    except ImportError as e:
        logger.error(f"Import Error: {e}")
        logger.error("Make sure you are running this from the project root and dependencies are installed.")
        sys.exit(1)
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()

