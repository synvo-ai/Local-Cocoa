#!/usr/bin/env python3
"""
PDF Pipeline Benchmarking Script

Measures timing for each stage of the PDF processing pipeline:
1. PDF Parsing (PyMuPDF text extraction)
2. OCR (if applicable - for scanned PDFs)  
3. Chunking (semantic chunking)
4. Embedding (vector generation)
5. VDB Storage (Qdrant upsert)

Usage:
    python scripts/benchmark_pdf_pipeline.py /path/to/file.pdf
    python scripts/benchmark_pdf_pipeline.py /path/to/file.pdf --skip-embedding
    python scripts/benchmark_pdf_pipeline.py /path/to/file.pdf --output logs/benchmark_result.json
"""

import sys
import time
import json
import asyncio
import argparse
import logging
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field, asdict
from typing import Optional

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).parent.parent.absolute()
sys.path.append(str(PROJECT_ROOT))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


@dataclass
class StageResult:
    """Result of a single pipeline stage."""
    stage_name: str
    duration_seconds: float
    success: bool
    output_count: int = 0
    output_size_chars: int = 0
    error_message: Optional[str] = None
    details: dict = field(default_factory=dict)


@dataclass
class BenchmarkResult:
    """Complete benchmark result."""
    file_path: str
    file_name: str
    file_size_bytes: int
    page_count: int
    timestamp: str
    stages: list = field(default_factory=list)
    total_duration_seconds: float = 0.0
    fast_index_duration_seconds: float = 0.0  # PDF + Chunk only (no embedding)
    
    def add_stage(self, result: StageResult):
        self.stages.append(asdict(result))
        self.total_duration_seconds += result.duration_seconds


def print_separator(char="-", width=60):
    print(char * width)


def format_duration(seconds: float) -> str:
    """Format duration in human-readable format."""
    if seconds < 1:
        return f"{seconds * 1000:.1f}ms"
    elif seconds < 60:
        return f"{seconds:.2f}s"
    else:
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.1f}s"


async def benchmark_pdf_parsing(file_path: Path) -> tuple[StageResult, any]:
    """Stage 1: PDF Parsing with PyMuPDF."""
    # Use PyMuPDF directly to avoid broken import chain in services.parser
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return StageResult(
            stage_name="pdf_parsing",
            duration_seconds=0,
            success=False,
            error_message="PyMuPDF (fitz) not installed"
        ), None
    
    logger.info("Stage 1: PDF Parsing (PyMuPDF text extraction)...")
    start = time.perf_counter()
    
    try:
        doc = fitz.open(str(file_path))
        
        page_texts = []
        page_mapping = []
        full_text = ""
        
        for page_num, page in enumerate(doc, start=1):
            # Get text using PyMuPDF's built-in method with sort=True for reading order
            text = page.get_text("text", sort=True)
            page_texts.append(text)
            
            start_pos = len(full_text)
            if full_text:
                full_text += "\n\n"
                start_pos = len(full_text)
            full_text += text
            end_pos = len(full_text)
            page_mapping.append((start_pos, end_pos, page_num))
        
        page_count = len(doc)
        doc.close()
        
        duration = time.perf_counter() - start
        
        # Create a simple parsed content object
        class ParsedContent:
            pass
        
        parsed_content = ParsedContent()
        parsed_content.text = full_text
        parsed_content.page_count = page_count
        parsed_content.page_mapping = page_mapping
        parsed_content.metadata = {"page_texts": page_texts}
        
        result = StageResult(
            stage_name="pdf_parsing",
            duration_seconds=duration,
            success=True,
            output_count=page_count,
            output_size_chars=len(full_text),
            details={
                "pages": page_count,
                "chars_extracted": len(full_text),
                "has_page_mapping": True,
                "page_mapping_count": len(page_mapping),
            }
        )
        logger.info(f"  ✓ Parsed {page_count} pages, {len(full_text):,} chars in {format_duration(duration)}")
        return result, parsed_content
    
    except Exception as e:
        duration = time.perf_counter() - start
        logger.error(f"  ✗ PDF parsing failed: {e}")
        return StageResult(
            stage_name="pdf_parsing",
            duration_seconds=duration,
            success=False,
            error_message=str(e)
        ), None


async def benchmark_chunking(parsed_content, file_id: str = "benchmark_test") -> tuple[StageResult, list]:
    """Stage 2: Semantic Chunking."""
    logger.info("Stage 2: Semantic Chunking...")
    start = time.perf_counter()
    
    try:
        from services.chunker.pipeline import ChunkingPipeline
        from services.core.config import settings
        
        pipeline = ChunkingPipeline()
        
        chunk_tokens = settings.rag_chunk_size
        overlap_tokens = settings.rag_chunk_overlap
        
        chunks = pipeline.build(
            file_id=file_id,
            text=parsed_content.text,
            page_mapping=parsed_content.page_mapping,
            chunk_tokens=chunk_tokens,
            overlap_tokens=overlap_tokens
        )
        duration = time.perf_counter() - start
        
        total_chunk_chars = sum(c.char_count for c in chunks)
        avg_chunk_size = total_chunk_chars // len(chunks) if chunks else 0
        
        result = StageResult(
            stage_name="chunking",
            duration_seconds=duration,
            success=True,
            output_count=len(chunks),
            output_size_chars=total_chunk_chars,
            details={
                "chunk_count": len(chunks),
                "total_chars": total_chunk_chars,
                "avg_chunk_chars": avg_chunk_size,
                "chunk_tokens_setting": chunk_tokens,
                "overlap_tokens_setting": overlap_tokens,
            }
        )
        logger.info(f"  ✓ Generated {len(chunks)} chunks ({total_chunk_chars:,} chars) in {format_duration(duration)}")
        return result, chunks
    
    except Exception as e:
        duration = time.perf_counter() - start
        logger.error(f"  ✗ Chunking failed: {e}")
        return StageResult(
            stage_name="chunking",
            duration_seconds=duration,
            success=False,
            error_message=str(e)
        ), []


async def benchmark_embedding(chunks: list) -> tuple[StageResult, list]:
    """Stage 3: Embedding generation via local embedding server."""
    logger.info("Stage 3: Embedding Generation...")
    
    if not chunks:
        logger.warning("  ⚠ No chunks to embed")
        return StageResult(
            stage_name="embedding",
            duration_seconds=0,
            success=True,
            output_count=0,
            details={"reason": "no_chunks"}
        ), []
    
    start = time.perf_counter()
    
    try:
        from services.llm.client import EmbeddingClient
        from services.core.config import settings
        
        client = EmbeddingClient()
        
        # Extract text from chunks
        texts = [chunk.text.strip() for chunk in chunks if chunk.text.strip()]
        
        if not texts:
            return StageResult(
                stage_name="embedding",
                duration_seconds=0,
                success=True,
                output_count=0,
                details={"reason": "empty_texts"}
            ), []
        
        # Truncate texts to stay under embedding server's 512 token limit
        # 1200 chars ≈ 300-350 tokens with buffer for tokenizer variations
        max_chars = min(settings.embed_max_chars, 1200)
        texts = [t[:max_chars] for t in texts]

        
        # Call embedding service with parallel batches for speed
        import httpx
        batch_size = 20       # Texts per batch (larger batch = less HTTP overhead)
        concurrency = 8       # Parallel requests (match server's parallel slots)
        
        vectors = []
        endpoint = f"{settings.endpoints.embedding.rstrip('/')}/v1/embeddings"
        
        # Split into batches
        batches = []
        for i in range(0, len(texts), batch_size):
            batches.append(texts[i:i + batch_size])
        
        logger.info(f"    Processing {len(texts)} texts: {len(batches)} batches × {batch_size} (concurrency={concurrency})")
        
        async def embed_batch(batch_texts: list, batch_idx: int) -> list:
            """Embed a single batch."""
            async with httpx.AsyncClient(timeout=120.0) as http_client:
                payload = {"input": batch_texts}
                response = await http_client.post(endpoint, json=payload)
                response.raise_for_status()
                data = response.json()
                
                result_vectors = []
                if "data" in data and isinstance(data["data"], list):
                    for item in data["data"]:
                        embedding = item.get("embedding")
                        if embedding:
                            result_vectors.append([float(v) for v in embedding])
                return result_vectors
        
        # Process batches with concurrency limit
        all_vectors = [None] * len(batches)  # Preserve order
        
        for wave_start in range(0, len(batches), concurrency):
            wave_end = min(wave_start + concurrency, len(batches))
            wave_batches = batches[wave_start:wave_end]
            wave_indices = list(range(wave_start, wave_end))
            
            # Run concurrent requests
            tasks = [embed_batch(batch, idx) for batch, idx in zip(wave_batches, wave_indices)]
            results = await asyncio.gather(*tasks)
            
            # Store results in order
            for idx, result in zip(wave_indices, results):
                all_vectors[idx] = result
            
            progress = (wave_end / len(batches)) * 100
            completed = wave_end * batch_size
            logger.info(f"    Wave {wave_start//concurrency + 1}: {min(completed, len(texts))}/{len(texts)} ({progress:.0f}%)")
        
        # Flatten results
        vectors = []
        for batch_result in all_vectors:
            if batch_result:
                vectors.extend(batch_result)


        duration = time.perf_counter() - start
        
        embedding_dim = len(vectors[0]) if vectors else 0
        
        result = StageResult(
            stage_name="embedding",
            duration_seconds=duration,
            success=True,
            output_count=len(vectors),
            details={
                "vectors_generated": len(vectors),
                "embedding_dimension": embedding_dim,
                "texts_embedded": len(texts),
                "avg_time_per_chunk_ms": (duration / len(texts)) * 1000 if texts else 0,
                "endpoint": settings.endpoints.embedding,
            }
        )
        logger.info(f"  ✓ Generated {len(vectors)} embeddings (dim={embedding_dim}) in {format_duration(duration)}")
        logger.info(f"    Average: {(duration / len(texts)) * 1000:.1f}ms per chunk")
        return result, vectors
    
    except Exception as e:
        duration = time.perf_counter() - start
        logger.error(f"  ✗ Embedding failed: {e}")
        return StageResult(
            stage_name="embedding",
            duration_seconds=duration,
            success=False,
            error_message=str(e)
        ), []


async def benchmark_vdb_storage(chunks: list, vectors: list, file_id: str = "benchmark_test") -> StageResult:
    """Stage 4: Vector Database Storage (Qdrant)."""
    logger.info("Stage 4: VDB Storage (Qdrant)...")
    
    if not chunks or not vectors:
        logger.warning("  ⚠ No data to store")
        return StageResult(
            stage_name="vdb_storage",
            duration_seconds=0,
            success=True,
            output_count=0,
            details={"reason": "no_data"}
        )
    
    start = time.perf_counter()
    
    try:
        from services.core.vector_store import VectorStore
        from services.core.models import VectorDocument
        
        store = VectorStore()
        
        # Prepare documents
        documents = []
        for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
            doc = VectorDocument(
                doc_id=f"{file_id}::chunk_{i}",
                vector=vector,
                metadata={
                    "chunk_id": f"{file_id}::chunk_{i}",
                    "file_id": file_id,
                    "snippet": chunk.snippet[:500] if hasattr(chunk, 'snippet') else chunk.text[:500],
                    "ordinal": i,
                }
            )
            documents.append(doc)
        
        # Upsert to vector store
        store.upsert(documents)
        store.flush()
        
        duration = time.perf_counter() - start
        
        result = StageResult(
            stage_name="vdb_storage",
            duration_seconds=duration,
            success=True,
            output_count=len(documents),
            details={
                "documents_stored": len(documents),
                "avg_time_per_doc_ms": (duration / len(documents)) * 1000 if documents else 0,
            }
        )
        logger.info(f"  ✓ Stored {len(documents)} vectors in {format_duration(duration)}")
        
        # Clean up benchmark data
        try:
            store.delete([d.doc_id for d in documents])
            logger.info("  ✓ Cleaned up benchmark data")
        except Exception:
            pass
        
        return result
    
    except Exception as e:
        duration = time.perf_counter() - start
        logger.error(f"  ✗ VDB storage failed: {e}")
        return StageResult(
            stage_name="vdb_storage",
            duration_seconds=duration,
            success=False,
            error_message=str(e)
        )


async def run_benchmark(file_path: Path, skip_embedding: bool = False, skip_vdb: bool = False) -> BenchmarkResult:
    """Run the complete benchmark pipeline."""
    
    stat = file_path.stat()
    
    result = BenchmarkResult(
        file_path=str(file_path),
        file_name=file_path.name,
        file_size_bytes=stat.st_size,
        page_count=0,
        timestamp=datetime.now().isoformat(),
    )
    
    print_separator("=")
    print(f"📄 PDF Pipeline Benchmark")
    print(f"   File: {file_path.name}")
    print(f"   Size: {stat.st_size / 1024:.1f} KB")
    print_separator("=")
    print()
    
    # Stage 1: PDF Parsing
    parse_result, parsed_content = await benchmark_pdf_parsing(file_path)
    result.add_stage(parse_result)
    result.page_count = parse_result.output_count
    
    if not parse_result.success or not parsed_content:
        return result
    
    # Stage 2: Chunking
    chunk_result, chunks = await benchmark_chunking(parsed_content, file_id="benchmark_test")
    result.add_stage(chunk_result)
    
    # Calculate Fast Index time (PDF parsing + Chunking only)
    result.fast_index_duration_seconds = parse_result.duration_seconds + chunk_result.duration_seconds
    
    if skip_embedding:
        logger.info("⏭ Skipping embedding stage (--skip-embedding)")
        result.add_stage(StageResult(
            stage_name="embedding",
            duration_seconds=0,
            success=True,
            details={"reason": "skipped"}
        ))
        result.add_stage(StageResult(
            stage_name="vdb_storage", 
            duration_seconds=0,
            success=True,
            details={"reason": "skipped"}
        ))
    else:
        # Stage 3: Embedding
        embed_result, vectors = await benchmark_embedding(chunks)
        result.add_stage(embed_result)
        
        if skip_vdb:
            logger.info("⏭ Skipping VDB storage stage (--skip-vdb)")
            result.add_stage(StageResult(
                stage_name="vdb_storage",
                duration_seconds=0,
                success=True,
                details={"reason": "skipped"}
            ))
        else:
            # Stage 4: VDB Storage
            vdb_result = await benchmark_vdb_storage(chunks, vectors, file_id="benchmark_test")
            result.add_stage(vdb_result)
    
    return result


def print_summary(result: BenchmarkResult):
    """Print a summary of the benchmark results."""
    print()
    print_separator("=")
    print("📊 BENCHMARK SUMMARY")
    print_separator("=")
    
    print(f"\n📄 File: {result.file_name}")
    print(f"   Size: {result.file_size_bytes / 1024:.1f} KB")
    print(f"   Pages: {result.page_count}")
    
    print(f"\n⏱ Stage Timings:")
    print_separator("-")
    
    for stage in result.stages:
        status = "✓" if stage["success"] else "✗"
        name = stage["stage_name"].replace("_", " ").title()
        duration = format_duration(stage["duration_seconds"])
        count = stage.get("output_count", 0)
        
        print(f"  {status} {name:20} {duration:>12}  ({count} items)")
    
    print_separator("-")
    print(f"  {'Total':21} {format_duration(result.total_duration_seconds):>12}")
    
    # Key insight: Fast Index vs Full Index
    print(f"\n💡 Key Insights:")
    print_separator("-")
    print(f"  🚀 Fast Index (PDF + Chunk):     {format_duration(result.fast_index_duration_seconds)}")
    
    embed_time = 0
    vdb_time = 0
    for stage in result.stages:
        if stage["stage_name"] == "embedding":
            embed_time = stage["duration_seconds"]
        elif stage["stage_name"] == "vdb_storage":
            vdb_time = stage["duration_seconds"]
    
    deep_index_extra = embed_time + vdb_time
    print(f"  🔍 Deep Index (+ Embed + VDB):   +{format_duration(deep_index_extra)}")
    print(f"  📈 Total Pipeline:               {format_duration(result.total_duration_seconds)}")
    
    if result.fast_index_duration_seconds > 0 and embed_time > 0:
        speedup = (embed_time + vdb_time) / result.fast_index_duration_seconds
        print(f"\n  ⚡ Fast Index is {speedup:.1f}x faster than embedding stage alone!")
    
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Benchmark PDF processing pipeline performance.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/benchmark_pdf_pipeline.py /path/to/document.pdf
  python scripts/benchmark_pdf_pipeline.py /path/to/document.pdf --skip-embedding
  python scripts/benchmark_pdf_pipeline.py /path/to/document.pdf -o logs/benchmark.json
        """
    )
    parser.add_argument("file_path", type=str, help="Path to the PDF file to benchmark")
    parser.add_argument("-o", "--output", type=str, help="Path to save JSON results")
    parser.add_argument("--skip-embedding", action="store_true", help="Skip embedding generation stage")
    parser.add_argument("--skip-vdb", action="store_true", help="Skip VDB storage stage")
    
    args = parser.parse_args()
    
    file_path = Path(args.file_path)
    if not file_path.exists():
        logger.error(f"File not found: {file_path}")
        sys.exit(1)
    
    if file_path.suffix.lower() != ".pdf":
        logger.error(f"File is not a PDF: {file_path}")
        sys.exit(1)
    
    try:
        result = asyncio.run(run_benchmark(
            file_path, 
            skip_embedding=args.skip_embedding,
            skip_vdb=args.skip_vdb
        ))
        
        print_summary(result)
        
        # Save results to JSON if requested
        if args.output:
            output_path = Path(args.output)
            if not output_path.is_absolute():
                output_path = PROJECT_ROOT / output_path
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(asdict(result), f, indent=2, ensure_ascii=False)
            logger.info(f"Results saved to: {output_path}")
        
    except KeyboardInterrupt:
        logger.info("Benchmark interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
