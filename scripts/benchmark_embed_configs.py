#!/usr/bin/env python3
"""
Benchmark different embedding client configurations.
Tests various batch_size and concurrency combinations to find optimal settings.
"""

import asyncio
import time
import sys
import json
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx
from services.core.config import settings

# Test configurations: (batch_size, concurrency)
CONFIGS = [
    (5, 1),     # Serial, small batch
    (10, 1),    # Serial, medium batch
    (20, 1),    # Serial, large batch
    (5, 2),     # Low parallel
    (10, 2),
    (20, 2),
    (5, 4),     # Medium parallel
    (10, 4),
    (20, 4),
    (5, 8),     # High parallel
    (10, 8),
    (20, 8),
]

async def run_benchmark(texts: list[str], batch_size: int, concurrency: int) -> dict:
    """Run embedding benchmark with given config."""
    max_chars = min(settings.embed_max_chars, 1200)
    texts = [t[:max_chars] for t in texts]
    
    endpoint = f"{settings.endpoints.embedding.rstrip('/')}/v1/embeddings"
    
    # Split into batches
    batches = []
    for i in range(0, len(texts), batch_size):
        batches.append(texts[i:i + batch_size])
    
    vectors = []
    start = time.perf_counter()
    
    async def embed_batch(batch_texts: list) -> list:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(endpoint, json={"input": batch_texts})
            response.raise_for_status()
            data = response.json()
            result = []
            if "data" in data:
                for item in data["data"]:
                    if "embedding" in item:
                        result.append(item["embedding"])
            return result
    
    all_vectors = [None] * len(batches)
    
    for wave_start in range(0, len(batches), concurrency):
        wave_end = min(wave_start + concurrency, len(batches))
        wave_batches = batches[wave_start:wave_end]
        wave_indices = list(range(wave_start, wave_end))
        
        tasks = [embed_batch(batch) for batch in wave_batches]
        results = await asyncio.gather(*tasks)
        
        for idx, result in zip(wave_indices, results):
            all_vectors[idx] = result
    
    for batch_result in all_vectors:
        if batch_result:
            vectors.extend(batch_result)
    
    duration = time.perf_counter() - start
    
    return {
        "batch_size": batch_size,
        "concurrency": concurrency,
        "num_batches": len(batches),
        "num_vectors": len(vectors),
        "duration_sec": round(duration, 2),
        "avg_ms_per_chunk": round((duration / len(texts)) * 1000, 1) if texts else 0,
        "throughput": round(len(texts) / duration, 1) if duration > 0 else 0,
    }

async def main():
    # Generate test texts (simulating chunks)
    print("=" * 60)
    print("Embedding Configuration Benchmark")
    print("=" * 60)
    
    # Load a real PDF for realistic test data
    import fitz
    pdf_path = "/Users/yangjingkang/Desktop/file/2024_ARS_Form_10-K_after_filing.pdf"
    
    print(f"\nLoading PDF: {pdf_path}")
    doc = fitz.open(pdf_path)
    full_text = ""
    for page in doc:
        full_text += page.get_text("text", sort=True) + "\n\n"
    doc.close()
    
    # Create chunks (simple split for benchmark)
    from services.chunker.pipeline import ChunkingPipeline
    pipeline = ChunkingPipeline()
    chunks = pipeline.build(file_id="test", text=full_text, page_mapping=[])
    texts = [c.text.strip() for c in chunks if c.text.strip()]
    
    print(f"Generated {len(texts)} chunks for testing")
    print()
    
    # Run benchmarks
    results = []
    for i, (batch_size, concurrency) in enumerate(CONFIGS):
        config_name = f"batch={batch_size}, concurrency={concurrency}"
        print(f"[{i+1}/{len(CONFIGS)}] Testing {config_name}...", end=" ", flush=True)
        
        try:
            result = await run_benchmark(texts, batch_size, concurrency)
            results.append(result)
            print(f"✓ {result['duration_sec']}s ({result['avg_ms_per_chunk']}ms/chunk)")
        except Exception as e:
            print(f"✗ Error: {e}")
            results.append({
                "batch_size": batch_size,
                "concurrency": concurrency,
                "error": str(e)
            })
        
        # Small delay between tests
        await asyncio.sleep(1)
    
    # Print summary
    print()
    print("=" * 60)
    print("RESULTS SUMMARY")
    print("=" * 60)
    print()
    print(f"{'Batch':<8} {'Conc':<6} {'Time':<10} {'ms/chunk':<10} {'chunks/s':<10}")
    print("-" * 50)
    
    # Sort by duration
    valid_results = [r for r in results if "error" not in r]
    valid_results.sort(key=lambda x: x["duration_sec"])
    
    for r in valid_results:
        print(f"{r['batch_size']:<8} {r['concurrency']:<6} {r['duration_sec']:<10} {r['avg_ms_per_chunk']:<10} {r['throughput']:<10}")
    
    print()
    if valid_results:
        best = valid_results[0]
        print(f"🏆 Best config: batch_size={best['batch_size']}, concurrency={best['concurrency']}")
        print(f"   Time: {best['duration_sec']}s, Throughput: {best['throughput']} chunks/s")
    
    # Save results
    output_path = Path(__file__).parent.parent / "logs" / "embed_config_benchmark.json"
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to: {output_path}")

if __name__ == "__main__":
    asyncio.run(main())
