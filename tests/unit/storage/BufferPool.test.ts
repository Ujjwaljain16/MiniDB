import { BufferPool } from '../../../src/storage/BufferPool';
import { DiskManager } from '../../../src/storage/DiskManager';
import type { ILogManager, LogRecord } from '../../../src/common/interfaces';
import type { PageId, LSN } from '../../../src/common/types';
import { INVALID_LSN } from '../../../src/common/types';
import { PAGE_SIZE } from '../../../src/common/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

class MockLogManager implements ILogManager {
  flushedLsn: LSN = INVALID_LSN;

  async append(record: Omit<LogRecord, 'lsn'>): Promise<LSN> {
    return 1 as LSN;
  }
  async flush(upToLsn: LSN): Promise<void> {
    if (upToLsn > this.flushedLsn) {
      this.flushedLsn = upToLsn;
    }
  }
  async *iterator(fromLsn: LSN): AsyncIterableIterator<LogRecord> {}
  currentLsn(): LSN { return 1 as LSN; }
  async close(): Promise<void> {}
}

describe('BufferPool', () => {
  let dm: DiskManager;
  let lm: MockLogManager;
  let pool: BufferPool;
  let testFile: string;

  beforeEach(async () => {
    testFile = path.join(os.tmpdir(), `minidb_bp_${Date.now()}_${Math.random()}.db`);
    dm = await DiskManager.open(testFile);
    lm = new MockLogManager();
    // Use a small pool of 3 frames to test LRU-K eviction easily
    pool = new BufferPool(dm, lm, 3);
  });

  afterEach(async () => {
    await dm.close();
    await fs.unlink(testFile).catch(() => {});
  });

  it('allocates new pages and fetches them', async () => {
    const [p1, buf1] = await pool.newPage();
    expect(p1).toBe(0);
    expect(buf1.length).toBe(PAGE_SIZE);
    
    // Write something
    buf1.write('page 0', 0);
    pool.unpinPage(p1, true);

    // Fetch it back
    const bufFetched = await pool.fetchPage(p1);
    expect(bufFetched.toString('utf8', 0, 6)).toBe('page 0');
    pool.unpinPage(p1, false);
  });

  it('evicts using LRU-K policy and flushes dirty pages', async () => {
    const [p0, b0] = await pool.newPage(); // frame 0 -> p0
    const [p1, b1] = await pool.newPage(); // frame 1 -> p1
    const [p2, b2] = await pool.newPage(); // frame 2 -> p2

    // All frames are pinned, eviction should fail
    await expect(pool.newPage()).rejects.toThrow('BufferPool: all frames are pinned, cannot evict');

    // Unpin p0 (dirty) and p1 (clean)
    pool.unpinPage(p0, true);
    pool.unpinPage(p1, false);

    // p0 has 1 access, p1 has 1 access. They are both < K (K=2).
    // The older one is p0. So p0 should be evicted.
    const [p3, b3] = await pool.newPage();
    expect(p3).toBe(3);
    
    // p0 was dirty, so it should have been written to disk
    // let's verify by fetching p0 (which will evict p1, the next oldest)
    pool.unpinPage(p2, false);
    
    // now we fetch p0
    const fetchedP0 = await pool.fetchPage(p0);
    pool.unpinPage(p0, false);
    
    expect(pool.stats().evictions).toBeGreaterThan(0);
    expect(pool.stats().dirtyPages).toBe(0); // p0 was flushed when evicted, p3 and fetchedP0 not dirty
  });

  it('enforces WAL rule on eviction', async () => {
    const [p0, b0] = await pool.newPage();
    pool.setPageLsn(p0, 42 as LSN);
    pool.unpinPage(p0, true); // dirty

    expect(lm.flushedLsn).toBe(INVALID_LSN);

    // Fill pool to force eviction of p0
    const [p1] = await pool.newPage();
    pool.unpinPage(p1, false);
    const [p2] = await pool.newPage();
    pool.unpinPage(p2, false);
    
    const [p3] = await pool.newPage(); // evicts p0
    pool.unpinPage(p3, false);

    // p0 was dirty with LSN 42, log manager should have been flushed to 42
    expect(lm.flushedLsn).toBe(42 as LSN);
  });
});
