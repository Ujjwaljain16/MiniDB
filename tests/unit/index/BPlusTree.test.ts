import { BPlusTree } from '../../../src/index/BPlusTree';
import { DiskManager } from '../../../src/storage/DiskManager';
import { BufferPool } from '../../../src/storage/BufferPool';
import type { ILogManager, LogRecord } from '../../../src/common/interfaces';
import type { ColumnDef, LSN, RID } from '../../../src/common/types';
import { makeRID } from '../../../src/common/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

class MockLogManager implements ILogManager {
  async append(record: Omit<LogRecord, 'lsn'>): Promise<LSN> { return 1 as LSN; }
  async flush(upToLsn: LSN): Promise<void> {}
  async *iterator(fromLsn: LSN): AsyncIterableIterator<LogRecord> {}
  currentLsn(): LSN { return 1 as LSN; }
  async close(): Promise<void> {}
}

describe('BPlusTree', () => {
  let dm: DiskManager;
  let lm: MockLogManager;
  let pool: BufferPool;
  let tree: BPlusTree;
  let testFile: string;

  const colDef: ColumnDef = { name: 'id', type: 'INT', nullable: false };

  beforeEach(async () => {
    testFile = path.join(os.tmpdir(), `minidb_btree_${Date.now()}_${Math.random()}.db`);
    dm = await DiskManager.open(testFile);
    lm = new MockLogManager();
    pool = new BufferPool(dm, lm, 64);
    tree = new BPlusTree(pool, colDef);
  });

  afterEach(async () => {
    await dm.close();
    await fs.unlink(testFile).catch(() => {});
  });

  it('inserts and searches 1000 sequential keys', async () => {
    const NUM_KEYS = 1000;
    
    // Insert
    for (let i = 1; i <= NUM_KEYS; i++) {
      const rid = makeRID(100, i);
      await tree.insert(i, rid);
    }

    // Verify all are searchable
    for (let i = 1; i <= NUM_KEYS; i++) {
      const rid = await tree.search(i);
      expect(rid).not.toBeNull();
      expect(rid!.pageId).toBe(100);
      expect(rid!.slotId).toBe(i);
    }

    // Verify non-existent keys
    expect(await tree.search(0)).toBeNull();
    expect(await tree.search(NUM_KEYS + 1)).toBeNull();

    // Verify tree height
    const height = await tree.height();
    expect(height).toBeGreaterThan(1);
    
    // Test searchRange
    const results: number[] = [];
    for await (const rid of tree.searchRange(50, 55)) {
      results.push(rid.slotId);
    }
    expect(results).toEqual([50, 51, 52, 53, 54, 55]);
  });
  
  it('handles splits with a 5-frame pool', async () => {
    // Reset pool with 5 frames
    pool = new BufferPool(dm, lm, 5);
    tree = new BPlusTree(pool, colDef);
    
    // A 5-frame pool should be enough to hold a path from root to leaf
    const NUM_KEYS = 5000; // Will cause multiple internal node splits
    for (let i = 1; i <= NUM_KEYS; i++) {
      const rid = makeRID(200, i);
      await tree.insert(i, rid);
    }
    
    const rid = await tree.search(2500);
    expect(rid).not.toBeNull();
    expect(rid!.slotId).toBe(2500);
    
    // Verify no pinned page leak
    const stats = pool.stats();
    expect(stats.pinnedPages).toBe(0);
  });

  it('bulk loads entries correctly', async () => {
    const entries: [number, RID][] = [];
    const NUM = 2000;
    for (let i = 1; i <= NUM; i++) {
      entries.push([i, makeRID(500, i)]);
    }
    
    await tree.bulkLoad(entries);
    
    const height = await tree.height();
    expect(height).toBeGreaterThan(1);
    
    // Verify searches
    const rid = await tree.search(1500);
    expect(rid).not.toBeNull();
    expect(rid!.pageId).toBe(500);
    expect(rid!.slotId).toBe(1500);
    
    expect(await tree.search(NUM + 1)).toBeNull();
    expect(pool.stats().pinnedPages).toBe(0);
  });

  it('deletes entries correctly', async () => {
    const NUM = 500;
    for (let i = 1; i <= NUM; i++) {
      await tree.insert(i, makeRID(10, i));
    }

    // Delete odd keys
    for (let i = 1; i <= NUM; i += 2) {
      await tree.delete(i);
    }
    
    // Verify odd keys are gone, even keys remain
    for (let i = 1; i <= NUM; i++) {
      const rid = await tree.search(i);
      if (i % 2 === 0) {
        expect(rid).not.toBeNull();
      } else {
        expect(rid).toBeNull();
      }
    }
    expect(pool.stats().pinnedPages).toBe(0);
  });
});
