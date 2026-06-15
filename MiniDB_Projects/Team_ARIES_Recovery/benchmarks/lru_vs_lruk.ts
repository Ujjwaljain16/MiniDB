import { BufferPool } from '../src/storage/BufferPool.js';

class MockDiskManager {
  async readPage(pageId: number, buffer: Buffer) { buffer.fill(0); }
  async writePage(pageId: number, buffer: Buffer) {}
  async allocatePage() { return 0; }
  async close() {}
}

class MockLogManager {
  async flush(lsn: bigint) {}
  async append() { return 0n; }
  async close() {}
}

async function runBenchmark() {
  console.log('--- Benchmark 3: LRU vs LRU-K Replacement Policy ---');
  console.log('Goal: Show how LRU-K prevents cache pollution from massive sequential scans.\n');
  
  const WORKLOAD_SIZE = 100_000;
  const POOL_SIZE = 100;
  const HOT_PAGES = 50;
  const COLD_PAGES = 10000;

  // Generate workload: 80% hits hot pages (1-50), 20% sequential scan (51-10000)
  const accesses: number[] = [];
  let seqIdx = HOT_PAGES + 1;
  for (let i = 0; i < WORKLOAD_SIZE; i++) {
    if (Math.random() < 0.8) {
      accesses.push(Math.floor(Math.random() * HOT_PAGES) + 1);
    } else {
      accesses.push(seqIdx);
      seqIdx++;
      if (seqIdx > COLD_PAGES) seqIdx = HOT_PAGES + 1;
    }
  }

  const runPolicy = async (k: number, name: string) => {
    const diskManager = new MockDiskManager() as any;
    const logManager = new MockLogManager() as any;
    const bufferPool = new BufferPool(diskManager, logManager, POOL_SIZE);
    bufferPool.K = k;

    // Clear initial stats
    (bufferPool as any).statsCounters = { hits: 0, misses: 0, evictions: 0 };

    const startTime = performance.now();
    for (const pageId of accesses) {
      const buf = await bufferPool.fetchPage(pageId);
      bufferPool.unpinPage(pageId, false);
    }
    const elapsed = performance.now() - startTime;
    
    const stats = bufferPool.stats();
    const hitRate = (stats.hits / (stats.hits + stats.misses)) * 100;

    console.log(`Policy: ${name}`);
    console.log(`Latency: ${elapsed.toFixed(2)} ms`);
    console.log(`Hits: ${stats.hits} | Misses: ${stats.misses}`);
    console.log(`Hit Rate: ${hitRate.toFixed(2)}%\n`);
  };

  await runPolicy(1, 'LRU (k=1)');
  await runPolicy(2, 'LRU-K (k=2)');
}

runBenchmark().catch(console.error);
