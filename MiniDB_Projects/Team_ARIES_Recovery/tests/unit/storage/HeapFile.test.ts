import { HeapFile, serializeTuple, deserializeTuple } from '../../../src/storage/HeapFile';
import { DiskManager } from '../../../src/storage/DiskManager';
import { BufferPool } from '../../../src/storage/BufferPool';
import { MemDiskManager } from '../../../src/storage/MemDiskManager';
import type { ILogManager, LogRecord } from '../../../src/common/interfaces';
import type { Schema, LSN, PageId } from '../../../src/common/types';
import { INVALID_LSN, makeRID } from '../../../src/common/types';
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

describe('Tuple Serialization', () => {
  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'score', type: 'FLOAT', nullable: true },
    { name: 'name', type: 'VARCHAR', nullable: true }
  ];

  it('serializes and deserializes correctly without nulls', () => {
    const tuple = [42, 3.14, 'hello'];
    const buf = serializeTuple(tuple, schema);
    const decoded = deserializeTuple(buf, schema);
    expect(decoded).toEqual(tuple);
  });

  it('serializes and deserializes correctly with nulls', () => {
    const tuple = [42, null, null];
    const buf = serializeTuple(tuple, schema);
    const decoded = deserializeTuple(buf, schema);
    expect(decoded).toEqual(tuple);
  });
});

describe('HeapFile', () => {
  let dm: DiskManager;
  let lm: MockLogManager;
  let bp: BufferPool;
  let hf: HeapFile;
  let testFile: string;

  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'name', type: 'VARCHAR', nullable: false }
  ];

  beforeEach(async () => {
    testFile = path.join(os.tmpdir(), `minidb_hf_${Date.now()}_${Math.random()}.db`);
    dm = await DiskManager.open(testFile);
    lm = new MockLogManager();
    bp = new BufferPool(dm, lm, 10);
    hf = new HeapFile('table1', bp, dm);
  });

  afterEach(async () => {
    await dm.close();
    await fs.unlink(testFile).catch(() => {});
  });

  it('inserts and retrieves a tuple', async () => {
    const tuple = [1, 'alice'];
    const rid = await hf.insertTuple(tuple, schema);
    expect(rid.pageId).toBe(1); // Page 0 is FSM, Page 1 is data
    expect(rid.slotId).toBe(0);

    const retrieved = await hf.getTuple(rid, schema);
    expect(retrieved).toEqual(tuple);
  });

  it('deletes a tuple', async () => {
    const tuple = [2, 'bob'];
    const rid = await hf.insertTuple(tuple, schema);
    await hf.deleteTuple(rid);
    
    const retrieved = await hf.getTuple(rid, schema);
    expect(retrieved).toBeNull();
  });

  it('updates a tuple', async () => {
    const tuple = [3, 'charlie'];
    const rid1 = await hf.insertTuple(tuple, schema);
    
    const newTuple = [3, 'charles'];
    const rid2 = await hf.updateTuple(rid1, newTuple, schema);
    
    if (rid1.pageId !== rid2.pageId || rid1.slotId !== rid2.slotId) {
      const oldTuple = await hf.getTuple(rid1, schema);
      expect(oldTuple).toBeNull();
    }

    const retrieved = await hf.getTuple(rid2, schema);
    expect(retrieved).toEqual(newTuple);
  });

  it('scans all tuples', async () => {
    await hf.insertTuple([10, 'A'], schema);
    await hf.insertTuple([20, 'B'], schema);
    const rid3 = await hf.insertTuple([30, 'C'], schema);
    
    await hf.deleteTuple(rid3); // Should not appear in scan

    const results = [];
    for await (const [rid, tuple] of hf.scan(schema)) {
      results.push(tuple);
    }

    expect(results.length).toBe(2);
    expect(results[0]).toEqual([10, 'A']);
    expect(results[1]).toEqual([20, 'B']);
  });

  it('fills pages to the brim without overflowing them', async () => {
    // One 10-byte record, then 29-byte ones, leaves exactly 32 free bytes on page 1:
    // enough for the record by the FSM's 16-byte count, but not for record + slot entry.
    await hf.insertTuple([0, 'abc'], schema);
    const name = 'n'.repeat(22);
    for (let i = 1; i <= 300; i++) {
      await hf.insertTuple([i, name], schema);
    }
    let count = 0;
    for await (const _ of hf.scan(schema)) count++;
    expect(count).toBe(301);
  });
});

describe('HeapFile with several heaps in one data file', () => {
  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'name', type: 'VARCHAR', nullable: false }
  ];

  it('scans and fills only its own pages', async () => {
    const dm = new MemDiskManager();
    const bp = new BufferPool(dm, new MockLogManager(), 4);
    const a = new HeapFile('a', bp, dm, 1, []);
    const b = new HeapFile('b', bp, dm, 2, []);

    const pad = 'p'.repeat(300);
    const ridsA = [];
    for (let i = 0; i < 40; i++) {
      ridsA.push(await a.insertTuple([i, pad], schema));
      await b.insertTuple([1000 + i, 'b'], schema);
    }
    await a.deleteTuple(ridsA[3]!);
    await b.insertTuple([2000, 'b'], schema);

    const pagesA = new Set(ridsA.map(r => r.pageId));
    const fetched: number[] = [];
    bp.onPageEvent = e => { if (e.type === 'hit' || e.type === 'miss') fetched.push(e.pageId); };
    const idsA = [];
    for await (const [, t] of a.scan(schema)) idsA.push(t[0]);
    expect(idsA).toEqual([...Array(40).keys()].filter(i => i !== 3));
    expect(fetched.every(p => pagesA.has(p as PageId))).toBe(true);
    bp.onPageEvent = null;

    const idsB = [];
    for await (const [rid, t] of b.scan(schema)) {
      expect(pagesA.has(rid.pageId)).toBe(false);
      idsB.push(t[0]);
    }
    expect(idsB).toEqual([...[...Array(40).keys()].map(i => 1000 + i), 2000]);

    // A heap opened later finds its pages from the page owners
    const again = new HeapFile('b', bp, dm, 2);
    let count = 0;
    for await (const _ of again.scan(schema)) count++;
    expect(count).toBe(41);
  });

  it('disowns its pages when released', async () => {
    const dm = new MemDiskManager();
    const bp = new BufferPool(dm, new MockLogManager(), 4);
    const a = new HeapFile('a', bp, dm, 1, []);
    for (let i = 0; i < 5; i++) await a.insertTuple([i, 'x'], schema);
    await a.releasePages();

    const reused = new HeapFile('a2', bp, dm, 1);
    let count = 0;
    for await (const _ of reused.scan(schema)) count++;
    expect(count).toBe(0);
  });
});
