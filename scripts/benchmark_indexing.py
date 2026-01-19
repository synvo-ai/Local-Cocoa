#!/usr/bin/env python3
"""
Benchmark script to identify indexing performance bottlenecks.

This script measures the time spent on each phase of the indexing pipeline:
1. PDF Parsing (OCR)
2. Checksum calculation
3. Chunking
4. Database writes

Usage:
    python scripts/benchmark_indexing.py /path/to/pdf/folder
"""

import sys
import time
import argparse
import logging
from pathlib import Path
from typing import Optional
import hashlib

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).parent.parent.absolute()
sys.path.append(str(PROJECT_ROOT))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)


class TimingStats:
    """Collect timing statistics."""
    
    def __init__(self):
        self.parse_times: list[float] = []
        self.checksum_times: list[float] = []
        self.chunk_times: list[float] = []
        self.db_write_times: list[float] = []
        self.total_times: list[float] = []
        
    def report(self, num_files: int):
        """Print timing report."""
        def avg(lst):
            return sum(lst) / len(lst) if lst else 0
        
        def total(lst):
            return sum(lst)
        
        logger.info("\n" + "=" * 60)
        logger.info("PERFORMANCE BENCHMARK RESULTS")
        logger.info("=" * 60)
        logger.info(f"Files processed: {num_files}")
        logger.info("")
        logger.info(f"{'Phase':<25} {'Total (s)':<12} {'Avg (s)':<12} {'%':<8}")
        logger.info("-" * 60)
        
        total_all = sum(self.total_times)
        
        phases = [
            ("PDF Parsing", self.parse_times),
            ("Checksum (SHA256)", self.checksum_times),
            ("Chunking", self.chunk_times),
            ("DB Writes", self.db_write_times),
        ]
        
        for name, times in phases:
            t = total(times)
            pct = (t / total_all * 100) if total_all > 0 else 0
            logger.info(f"{name:<25} {t:<12.2f} {avg(times):<12.4f} {pct:<8.1f}")
        
        logger.info("-" * 60)
        logger.info(f"{'Total':<25} {total_all:<12.2f} {avg(self.total_times):<12.4f}")
        logger.info("")
        logger.info("BOTTLENECK ANALYSIS:")
        
        if total_all > 0:
            checksum_pct = sum(self.checksum_times) / total_all * 100
            db_pct = sum(self.db_write_times) / total_all * 100
            parse_pct = sum(self.parse_times) / total_all * 100
            
            if checksum_pct > 30:
                logger.info(f"  ⚠️  Checksum calculation takes {checksum_pct:.1f}% of time")
                logger.info("      Consider: lazy checksum calculation or caching")
            if db_pct > 30:
                logger.info(f"  ⚠️  Database writes take {db_pct:.1f}% of time")
                logger.info("      Consider: batch writes, WAL mode, or async writes")
            if parse_pct > 50:
                logger.info(f"  ✓ PDF parsing is the main bottleneck ({parse_pct:.1f}%)")
                logger.info("      This is expected - OCR is inherently slow")


def checksum(path: Path) -> str:
    """Simulate the checksum calculation from scanner.py"""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(path: Path) -> str:
    """Generate file ID like scanner.py"""
    digest = hashlib.sha1()
    digest.update(str(path.resolve()).encode("utf-8"))
    return digest.hexdigest()


def benchmark_single_file(
    file_path: Path,
    stats: TimingStats,
    simulate_db_write: bool = True,
    sqlite_conn = None
) -> Optional[dict]:
    """Benchmark processing a single file."""
    from services.parser.pdf import PdfParser
    try:
        from services.chunker.pipeline import ChunkingPipeline
    except ImportError:
        ChunkingPipeline = None
    
    total_start = time.perf_counter()
    
    # 1. PDF Parsing
    parse_start = time.perf_counter()
    pdf_parser = PdfParser()
    try:
        parsed_content = pdf_parser.parse(file_path)
    except Exception as e:
        logger.error(f"  Failed to parse {file_path.name}: {e}")
        return None
    parse_time = time.perf_counter() - parse_start
    stats.parse_times.append(parse_time)
    
    # 2. Checksum calculation (this is done in FastTextProcessor)
    checksum_start = time.perf_counter()
    file_checksum = checksum(file_path)
    checksum_time = time.perf_counter() - checksum_start
    stats.checksum_times.append(checksum_time)
    
    # 3. Chunking
    chunk_start = time.perf_counter()
    chunks = []
    if ChunkingPipeline:
        pipeline = ChunkingPipeline()
        file_id = fingerprint(file_path)
        chunks = pipeline.build(
            file_id=file_id,
            text=parsed_content.text,
            page_mapping=parsed_content.page_mapping
        )
    chunk_time = time.perf_counter() - chunk_start
    stats.chunk_times.append(chunk_time)
    
    # 4. Simulate database writes
    db_start = time.perf_counter()
    if simulate_db_write and sqlite_conn:
        cursor = sqlite_conn.cursor()
        
        # Simulate replace_chunks: DELETE + INSERT
        file_id = fingerprint(file_path)
        cursor.execute("DELETE FROM bench_chunks WHERE file_id = ?", (file_id,))
        
        for i, chunk in enumerate(chunks):
            cursor.execute(
                """
                INSERT INTO bench_chunks (id, file_id, ordinal, text, snippet)
                VALUES (?, ?, ?, ?, ?)
                """,
                (f"{file_id}::{i}", file_id, i, chunk.text, chunk.snippet)
            )
        
        # Simulate upsert_file
        cursor.execute(
            """
            INSERT OR REPLACE INTO bench_files (id, path, name, checksum, text_len)
            VALUES (?, ?, ?, ?, ?)
            """,
            (file_id, str(file_path), file_path.name, file_checksum, len(parsed_content.text))
        )
        sqlite_conn.commit()
    
    db_time = time.perf_counter() - db_start
    stats.db_write_times.append(db_time)
    
    total_time = time.perf_counter() - total_start
    stats.total_times.append(total_time)
    
    return {
        "file": file_path.name,
        "pages": parsed_content.page_count,
        "chars": len(parsed_content.text),
        "chunks": len(chunks),
        "parse_time": parse_time,
        "checksum_time": checksum_time,
        "chunk_time": chunk_time,
        "db_time": db_time,
        "total_time": total_time,
    }


def create_test_db(db_path: Path):
    """Create a test SQLite database to simulate writes."""
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bench_files (
            id TEXT PRIMARY KEY,
            path TEXT,
            name TEXT,
            checksum TEXT,
            text_len INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bench_chunks (
            id TEXT PRIMARY KEY,
            file_id TEXT,
            ordinal INTEGER,
            text TEXT,
            snippet TEXT
        )
    """)
    conn.commit()
    return conn


def benchmark_directory(dir_path: Path, max_files: int = 100):
    """Benchmark all PDFs in a directory."""
    import tempfile
    
    pdf_files = sorted(dir_path.glob("*.pdf"))[:max_files]
    
    if not pdf_files:
        logger.error(f"No PDF files found in {dir_path}")
        return
    
    logger.info(f"Found {len(pdf_files)} PDF files")
    logger.info("=" * 60)
    
    stats = TimingStats()
    
    # Create temporary database for simulating writes
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        db_path = Path(tmp.name)
    
    conn = create_test_db(db_path)
    
    try:
        for i, pdf_file in enumerate(pdf_files, 1):
            logger.info(f"[{i}/{len(pdf_files)}] Processing: {pdf_file.name}")
            
            result = benchmark_single_file(pdf_file, stats, simulate_db_write=True, sqlite_conn=conn)
            
            if result:
                logger.info(
                    f"  Parse: {result['parse_time']:.2f}s | "
                    f"Checksum: {result['checksum_time']:.2f}s | "
                    f"Chunk: {result['chunk_time']:.2f}s | "
                    f"DB: {result['db_time']:.2f}s | "
                    f"Total: {result['total_time']:.2f}s"
                )
    finally:
        conn.close()
        db_path.unlink()
    
    stats.report(len(pdf_files))


def main():
    parser = argparse.ArgumentParser(description="Benchmark indexing pipeline performance.")
    parser.add_argument("path", type=str, help="Path to PDF file or directory")
    parser.add_argument("-n", "--max-files", type=int, default=100,
                       help="Maximum number of files to process")
    args = parser.parse_args()
    
    input_path = Path(args.path)
    
    if not input_path.exists():
        logger.error(f"Path not found: {input_path}")
        sys.exit(1)
    
    if input_path.is_dir():
        benchmark_directory(input_path, args.max_files)
    else:
        # Single file
        stats = TimingStats()
        result = benchmark_single_file(input_path, stats, simulate_db_write=False)
        if result:
            stats.report(1)


if __name__ == "__main__":
    main()

