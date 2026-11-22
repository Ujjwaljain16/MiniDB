import { BPlusTree } from '../../../src/index/BPlusTree';
import { DiskManager } from '../../../src/storage/DiskManager';
import { BufferPool } from '../../../src/storage/BufferPool';
import type { ILogManager, LogRecord } from '../../../src/common/interfaces';
import type { ColumnDef, LSN } from '../../../src/common/types';
import { makeRID } from '../../../src/common/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

class MockLogManager implements ILogManager {
  async append(_record: Omit<LogRecord, 'lsn'>): Promise<LSN> { return 1 as LSN; }
  async flush(_upToLsn: LSN): Promise<void> {}
  async *iterator(_fromLsn: LSN): AsyncIterableIterator<LogRecord> {}
  currentLsn(): LSN { return 1 as LSN; }
  async close(): Promise<void> {}
}

describe('BPlusTree range scans', () => {
  let dm: DiskManager;
  let pool: BufferPool;
  let tree: BPlusTree;
  let testFile: string;

  const colDef: ColumnDef = { name: 'k', type: 'INT', nullable: false };

  beforeEach(async () => {
    testFile = path.join(os.tmpdir(), `minidb_btree_range_${Date.now()}_${Math.random()}.db`);
    dm = await DiskManager.open(testFile);
    pool = new BufferPool(dm, new MockLogManager(), 64);
    tree = new BPlusTree(pool, colDef);
  });

  afterEach(async () => {
    await dm.close();
    await fs.unlink(testFile).catch(() => {});
  });

  async function collect(low: number | null, high: number | null): Promise<number[]> {
    const out: number[] = [];
    for await (const rid of tree.searchRange(low, high)) out.push(rid.pageId * 100000 + rid.slotId);
    return out;
  }

  it('supports open lower and upper bounds', async () => {
    for (let i = 1; i <= 3000; i++) await tree.insert(i, makeRID(0, i));
    expect(await tree.height()).toBeGreaterThan(1);

    expect(await collect(2996, null)).toEqual([2996, 2997, 2998, 2999, 3000]);
    expect(await collect(null, 3)).toEqual([1, 2, 3]);
    expect((await collect(null, null)).length).toBe(3000);
    expect(await collect(3001, null)).toEqual([]);
    expect(await collect(10, 5)).toEqual([]);
    expect(pool.stats().pinnedPages).toBe(0);
  });

  it('finds every duplicate of a key even when they span leaves', async () => {
    // 6000 entries over 10 keys: each key has 600 copies, more than one leaf holds.
    for (let i = 0; i < 6000; i++) await tree.insert(i % 10, makeRID(1, i));
    for (let k = 0; k < 10; k++) {
      expect((await collect(k, k)).length).toBe(600);
    }
    expect((await collect(7, null)).length).toBe(1800);
    expect((await collect(null, 2)).length).toBe(1800);
    expect(pool.stats().pinnedPages).toBe(0);
  });

  it('describes every node breadth-first and unpins them', async () => {
    expect(await tree.describe()).toEqual({ rootPageId: -1, height: 0, nodes: [] });

    for (let i = 1; i <= 3000; i++) await tree.insert(i, makeRID(0, i));
    const d = await tree.describe();
    expect(d.rootPageId).toBe(tree.rootPageId());
    expect(d.height).toBe(await tree.height());
    expect(d.nodes[0]!.pageId).toBe(d.rootPageId);
    expect(d.nodes[0]!.isLeaf).toBe(false);

    const leaves = d.nodes.filter(n => n.isLeaf);
    expect(leaves.flatMap(n => n.keys)).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1));
    leaves.forEach((leaf, i) => {
      expect(leaf.children).toEqual([]);
      expect(leaf.nextLeafId).toBe(i + 1 < leaves.length ? leaves[i + 1]!.pageId : -1);
    });
    for (const n of d.nodes.filter(n => !n.isLeaf)) {
      expect(n.children.length).toBe(n.keys.length + 1);
      expect(n.nextLeafId).toBe(-1);
    }
    expect(pool.stats().pinnedPages).toBe(0);
  });

  it('unpins the current leaf when the consumer stops early', async () => {
    for (let i = 1; i <= 2000; i++) await tree.insert(i, makeRID(0, i));
    let seen = 0;
    for await (const _rid of tree.searchRange(null, null)) {
      if (++seen === 10) break;
    }
    expect(seen).toBe(10);
    expect(pool.stats().pinnedPages).toBe(0);
  });
});
