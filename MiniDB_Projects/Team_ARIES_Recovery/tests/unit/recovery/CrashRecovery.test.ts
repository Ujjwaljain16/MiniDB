import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { DiskManager } from '../../../src/storage/DiskManager.js';
import { BufferPool } from '../../../src/storage/BufferPool.js';
import { LogManager } from '../../../src/recovery/LogManager.js';
import { TxnManager } from '../../../src/concurrency/TxnManager.js';
import { LockManager } from '../../../src/concurrency/LockManager.js';
import { HeapFile, serializeTuple } from '../../../src/storage/HeapFile.js';
import { recover } from '../../../src/recovery/CrashRecovery.js';
import { CheckpointManager } from '../../../src/recovery/CheckpointManager.js';
import type { Schema } from '../../../src/common/types.js';

describe('CrashRecovery', () => {
  let tempDir: string;
  let schema: Schema;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-crash-test-'));
    schema = [{ name: 'id', type: 'INT', nullable: false }, { name: 'val', type: 'VARCHAR', nullable: true }];
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('performs ARIES-lite recovery (end-to-end integration)', async () => {
    let diskManager1 = await DiskManager.open(path.join(tempDir, 'data.db'));
    let logManager1 = new LogManager(path.join(tempDir, 'wal.log'));
    await logManager1.init();
    let bufferPool1 = new BufferPool(diskManager1, logManager1, 10);
    let txnManager1 = new TxnManager(new LockManager(), logManager1);
    let heapFile1 = new HeapFile('table1', bufferPool1, diskManager1);

    // 1. Commit 10 rows
    const txn1 = await txnManager1.begin();
    const insertedRids = [];
    for (let i = 0; i < 10; i++) {
      const tuple = [i, `val${i}`];
      const rid = await heapFile1.insertTuple(tuple, schema);
      insertedRids.push(rid);

      // Write WAL record (simplified, no beforeImage)
      const afterImage = serializeTuple(tuple, schema);
      const lsn = await logManager1.append({
        txnId: txn1.txnId,
        type: 'INSERT',
        prevLsn: txn1.prevLsn,
        tableId: 'table1' as any,
        rid,
        afterImage
      });
      txn1.prevLsn = lsn;
      bufferPool1.setPageLsn(rid.pageId, lsn);
    }
    await txnManager1.commit(txn1.txnId);

    // 2. Uncommitted insert of 1 row (loser)
    const txn2 = await txnManager1.begin();
    const tuple2 = [999, `val999`];
    const rid2 = await heapFile1.insertTuple(tuple2, schema);
    const afterImage2 = serializeTuple(tuple2, schema);
    const lsn2 = await logManager1.append({
      txnId: txn2.txnId,
      type: 'INSERT',
      prevLsn: txn2.prevLsn,
      tableId: 'table1' as any,
      rid: rid2,
      afterImage: afterImage2
    });
    txn2.prevLsn = lsn2;
    bufferPool1.setPageLsn(rid2.pageId, lsn2);

    // 3. Write a fuzzy checkpoint right now
    const cpManager1 = new CheckpointManager(logManager1, bufferPool1, txnManager1, tempDir);
    await cpManager1.writeCheckpoint();

    // 4. Force a write to disk of the first few pages (so that they don't need redo)
    // but leave the last page in buffer pool dirty so it DOES need redo.
    // We intentionally don't flush the buffer pool.

    // Simulate CRASH: Drop instances without cleanly shutting down.
    await logManager1.close();
    // Do NOT call bufferPool1.flushAll()

    // 5. Instantiate new engine
    let diskManager2 = await DiskManager.open(path.join(tempDir, 'data.db'));
    let logManager2 = new LogManager(path.join(tempDir, 'wal.log'));
    await logManager2.init();
    let bufferPool2 = new BufferPool(diskManager2, logManager2, 10);
    let txnManager2 = new TxnManager(new LockManager(), logManager2);

    // 6. Recover
    await recover(logManager2, bufferPool2, txnManager2, tempDir);

    // 7. Verify
    let heapFile2 = new HeapFile('table1', bufferPool2, diskManager2);
    const recoveredTuples = [];
    for await (const [rid, tuple] of heapFile2.scan(schema)) {
      recoveredTuples.push(tuple);
    }

    // Expect exactly 10 tuples (0 to 9), not 11.
    expect(recoveredTuples.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(recoveredTuples[i]![0]).toBe(i);
    }
    
    await logManager2.close();
  });

  it('performs idempotent redo (crash during recovery)', async () => {
    let diskManager1 = await DiskManager.open(path.join(tempDir, 'data.db'));
    let logManager1 = new LogManager(path.join(tempDir, 'wal.log'));
    await logManager1.init();
    let bufferPool1 = new BufferPool(diskManager1, logManager1, 10);
    let txnManager1 = new TxnManager(new LockManager(), logManager1);
    let heapFile1 = new HeapFile('table1', bufferPool1, diskManager1);

    const txn1 = await txnManager1.begin();
    for (let i = 0; i < 5; i++) {
      const tuple = [i, `v${i}`];
      const rid = await heapFile1.insertTuple(tuple, schema);
      const afterImage = serializeTuple(tuple, schema);
      const lsn = await logManager1.append({
        txnId: txn1.txnId,
        type: 'INSERT',
        prevLsn: txn1.prevLsn,
        tableId: 'table1' as any,
        rid,
        afterImage
      });
      txn1.prevLsn = lsn;
      bufferPool1.setPageLsn(rid.pageId, lsn);
    }
    await txnManager1.commit(txn1.txnId);
    
    await logManager1.close();

    let finalBufferPool: BufferPool;
    let finalDiskManager: DiskManager;
    let finalLogManager: LogManager;

    // Recover twice
    for (let attempt = 1; attempt <= 2; attempt++) {
      finalDiskManager = await DiskManager.open(path.join(tempDir, 'data.db'));
      finalLogManager = new LogManager(path.join(tempDir, 'wal.log'));
      await finalLogManager.init();
      finalBufferPool = new BufferPool(finalDiskManager, finalLogManager, 10);
      let txnManager2 = new TxnManager(new LockManager(), finalLogManager);
      
      await recover(finalLogManager, finalBufferPool, txnManager2, tempDir);
      if (attempt === 1) {
        await finalLogManager.close();
      }
    }

    // Verify using the final buffer pool that is active
    let heapFile3 = new HeapFile('table1', finalBufferPool!, finalDiskManager!);

    const recoveredTuples = [];
    for await (const [rid, tuple] of heapFile3.scan(schema)) {
      recoveredTuples.push(tuple);
    }

    expect(recoveredTuples.length).toBe(5);
    await finalLogManager!.close();
  });
});
