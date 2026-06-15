import { HeapFile, serializeTuple, deserializeTuple } from '../../../src/storage/HeapFile';
import { DiskManager } from '../../../src/storage/DiskManager';
import { BufferPool } from '../../../src/storage/BufferPool';
import type { ILogManager, LogRecord } from '../../../src/common/interfaces';
import type { Schema, LSN } from '../../../src/common/types';
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
});
