import { BufferPool } from '../../../src/storage/BufferPool';
import { DiskManager } from '../../../src/storage/DiskManager';
import { MemDiskManager } from '../../../src/storage/MemDiskManager';
import type { ILogManager, LogRecord, PageEvent } from '../../../src/common/interfaces';
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

  it('torture test: 10000 operations on 100 pages with pool size 3', async () => {
    const NUM_PAGES = 100;
    const OPERATIONS = 10000;
    const pageIds: PageId[] = [];

    // Create 100 pages
    for (let i = 0; i < NUM_PAGES; i++) {
      const [pid, buf] = await pool.newPage();
      pageIds.push(pid);
      
      // Write some initial data to each page (e.g. its own ID)
      buf.writeInt32LE(pid, 0);
      pool.unpinPage(pid, true); // initial write makes it dirty
    }

    // Now perform 10000 random reads/writes
    let successfulOps = 0;
    for (let i = 0; i < OPERATIONS; i++) {
      const targetPid = pageIds[Math.floor(Math.random() * NUM_PAGES)]!;
      const isWrite = Math.random() < 0.2; // 20% writes

      const buf = await pool.fetchPage(targetPid);
      
      // Verify data integrity (it should hold its own ID)
      const readVal = buf.readInt32LE(0);
      if (readVal !== targetPid) {
        throw new Error(`Data corruption! Expected ${targetPid}, got ${readVal}`);
      }

      if (isWrite) {
        // Redundant write, but marks dirty
        buf.writeInt32LE(targetPid, 0);
      }

      pool.unpinPage(targetPid, isWrite);
      successfulOps++;
    }

    expect(successfulOps).toBe(OPERATIONS);
    
    // Test passes if no "all frames are pinned" exception occurred
    // and no data corruption was found (dirty pages were correctly flushed and reloaded)
    
    // Final stats check
    const stats = pool.stats();
    expect(stats.hits + stats.misses).toBe(OPERATIONS);
    expect(stats.evictions).toBeGreaterThan(0);
  }, 30000);
});

describe('BufferPool page events', () => {
  let pool: BufferPool;
  let events: PageEvent[];

  beforeEach(() => {
    pool = new BufferPool(new MemDiskManager(), new MockLogManager(), 2);
    events = [];
  });

  async function makePage(type: number | null): Promise<PageId> {
    const [pid, buf] = await pool.newPage();
    if (type !== null) buf.writeUInt8(type, 16);
    pool.unpinPage(pid, true);
    return pid;
  }

  async function touch(pid: PageId): Promise<void> {
    await pool.fetchPage(pid);
    pool.unpinPage(pid, false);
  }

  it('reports new, evict, flush, miss and hit with the page kind', async () => {
    const fsm = await makePage(3);   // page 0
    const leaf = await makePage(1);  // page 1
    pool.onPageEvent = e => events.push(e);

    const heap = await makePage(0);  // page 2 evicts page 0 (dirty)
    expect(events).toEqual([
      { type: 'evict', pageId: fsm, frame: 0, kind: 'fsm', dirty: true },
      { type: 'flush', pageId: fsm, frame: 0, kind: 'fsm' },
      { type: 'new', pageId: heap, frame: 0, kind: 'unknown' },
    ]);

    events = [];
    await touch(heap);
    await touch(fsm); // evicts the leaf, which is dirty
    expect(events).toEqual([
      { type: 'hit', pageId: heap, frame: 0, kind: 'heap' },
      { type: 'evict', pageId: leaf, frame: 1, kind: 'btree-leaf', dirty: true },
      { type: 'flush', pageId: leaf, frame: 1, kind: 'btree-leaf' },
      { type: 'miss', pageId: fsm, frame: 1, kind: 'fsm' },
    ]);

    events = [];
    const internal = await makePage(2);
    await touch(internal);
    await pool.flushAll();
    expect(events.filter(e => e.type === 'hit')).toEqual([{ type: 'hit', pageId: internal, frame: 1, kind: 'btree-internal' }]);
    expect(events.filter(e => e.type === 'evict')[0]).toMatchObject({ pageId: fsm, dirty: false });
    expect(events.filter(e => e.type === 'flush')).toEqual([
      { type: 'flush', pageId: heap, frame: 0, kind: 'heap' },
      { type: 'flush', pageId: internal, frame: 1, kind: 'btree-internal' },
    ]);
  });

  it('reports a flushPage write and snapshots every frame', async () => {
    const fsm = await makePage(3);
    const heap = await makePage(0);
    await touch(fsm);
    await pool.fetchPage(heap);
    pool.onPageEvent = e => events.push(e);
    await pool.flushPage(heap);
    expect(events).toEqual([{ type: 'flush', pageId: heap, frame: 1, kind: 'heap' }]);

    expect(pool.snapshot()).toEqual([
      { frame: 0, pageId: fsm, pinCount: 0, dirty: true, kind: 'fsm' },
      { frame: 1, pageId: heap, pinCount: 1, dirty: false, kind: 'heap' },
    ]);
    pool.unpinPage(heap, false);
  });

  it('snapshots empty frames as unknown', () => {
    expect(pool.snapshot()).toEqual([
      { frame: 0, pageId: -1, pinCount: 0, dirty: false, kind: 'unknown' },
      { frame: 1, pageId: -1, pinCount: 0, dirty: false, kind: 'unknown' },
    ]);
  });
});
