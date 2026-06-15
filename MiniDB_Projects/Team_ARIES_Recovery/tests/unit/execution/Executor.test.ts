import fs from 'fs';
import path from 'path';
import { DiskManager } from '../../../src/storage/DiskManager.js';
import { LogManager } from '../../../src/recovery/LogManager.js';
import { BufferPool } from '../../../src/storage/BufferPool.js';
import { LockManager } from '../../../src/concurrency/LockManager.js';
import { TxnManager } from '../../../src/concurrency/TxnManager.js';
import { JSONCatalogStorage } from '../../../src/catalog/JSONCatalogStorage.js';
import { Catalog } from '../../../src/catalog/Catalog.js';
import { Executor } from '../../../src/execution/Executor.js';
import type { PhysSeqScan, PhysInsert, PhysDelete, PhysFilter } from '../../../src/optimizer/PhysicalPlan.js';
import type { ExecContext } from '../../../src/common/interfaces.js';
import { recover } from '../../../src/recovery/CrashRecovery.js';
import type { Schema } from '../../../src/common/types.js';

describe('Executor', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'executor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupDB(dir: string) {
    const diskManager = await DiskManager.open(path.join(dir, 'data.db'));
    const logManager = new LogManager(path.join(dir, 'wal.log'));
    await logManager.init();
    const bufferPool = new BufferPool(diskManager, logManager, 100);
    const lockManager = new LockManager();
    const txnManager = new TxnManager(lockManager, logManager);
    
    const catalogStorage = new JSONCatalogStorage(path.join(dir, 'catalog.json'));
    const catalog = new Catalog(catalogStorage, bufferPool, diskManager);
    await catalog.load();

    return { diskManager, logManager, bufferPool, lockManager, txnManager, catalog };
  }

  test('E2E Execution: Insert, Select, Delete', async () => {
    const db = await setupDB(tempDir);
    const schema: Schema = [
      { name: 'id', type: 'INT', nullable: false },
      { name: 'name', type: 'VARCHAR', maxLen: 50, nullable: false }
    ];
    await db.catalog.createTable({
      tableId: 'users' as any,
      heapFile: 'users.heap',
      schema,
      primaryKey: 'id',
      indexes: {}
    });

    const executor = new Executor();
    const txn = await db.txnManager.begin();

    const ctx: ExecContext = {
      txn,
      txnManager: db.txnManager,
      lockManager: db.lockManager,
      catalog: db.catalog,
      bufferPool: db.bufferPool,
      logManager: db.logManager
    };

    // 1. Insert two rows
    const insertPlan: PhysInsert = {
      kind: 'phys_insert',
      tableId: 'users' as any,
      columns: ['id', 'name'],
      values: [
        [{ kind: 'bound_literal', value: 1, type: 'INT' }, { kind: 'bound_literal', value: 'Alice', type: 'VARCHAR' }],
        [{ kind: 'bound_literal', value: 2, type: 'INT' }, { kind: 'bound_literal', value: 'Bob', type: 'VARCHAR' }]
      ],
      estRows: 2,
      estCost: 2
    };

    const insertResult = await executor.execute(insertPlan, ctx);
    expect(insertResult.rows[0]![0]).toBe(2); // 2 affected rows

    // 2. Select using SeqScan
    const scanPlan: PhysSeqScan = {
      kind: 'phys_seq_scan',
      tableId: 'users' as any,
      schema,
      estRows: 2,
      estCost: 1
    };

    const scanResult = await executor.execute(scanPlan, ctx);
    expect(scanResult.rows.length).toBe(2);
    expect(scanResult.rows[0]).toEqual([1, 'Alice']);
    expect(scanResult.rows[1]).toEqual([2, 'Bob']);

    // 3. Delete one row (Bob) using Filter -> Delete
    const filterPlan: PhysFilter = {
      kind: 'phys_filter',
      child: scanPlan,
      predicate: {
        kind: 'bound_binary',
        op: '=',
        left: { kind: 'bound_col', tableId: 'users' as any, columnName: 'id', columnIndex: 0, type: 'INT' },
        right: { kind: 'bound_literal', value: 2, type: 'INT' }
      },
      estRows: 1,
      estCost: 1
    };
    const deletePlan: PhysDelete = {
      kind: 'phys_delete',
      tableId: 'users' as any,
      child: filterPlan,
      estRows: 1,
      estCost: 1
    };

    const deleteResult = await executor.execute(deletePlan, ctx);
    expect(deleteResult.rows[0]![0]).toBe(1); // 1 affected row

    // 4. Select again
    const finalScanResult = await executor.execute(scanPlan, ctx);
    expect(finalScanResult.rows.length).toBe(1);
    expect(finalScanResult.rows[0]).toEqual([1, 'Alice']);

    await db.txnManager.commit(txn.txnId);
    await db.logManager.close();
  });

  test('Strict 2PL Visibility', async () => {
    const db = await setupDB(tempDir);
    const schema: Schema = [{ name: 'id', type: 'INT', nullable: false }, { name: 'name', type: 'VARCHAR', maxLen: 50, nullable: false }];
    await db.catalog.createTable({
      tableId: 'users' as any, heapFile: 'users.heap', schema, primaryKey: 'id', indexes: {}
    });

    const executor = new Executor();
    
    // Txn1 inserts Alice but does NOT commit
    const txn1 = await db.txnManager.begin();
    const ctx1: ExecContext = { ...db, txn: txn1 } as any;
    
    const insertPlan: PhysInsert = {
      kind: 'phys_insert',
      tableId: 'users' as any,
      columns: ['id', 'name'],
      values: [[{ kind: 'bound_literal', value: 1, type: 'INT' }, { kind: 'bound_literal', value: 'Alice', type: 'VARCHAR' }]],
      estRows: 1, estCost: 1
    };
    await executor.execute(insertPlan, ctx1);

    // Txn2 tries to scan
    const txn2 = await db.txnManager.begin();
    const ctx2: ExecContext = { ...db, txn: txn2 } as any;
    const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'users' as any, schema, estRows: 1, estCost: 1 };

    // This scan should block because Txn1 holds X lock on the RID
    let scanCompleted = false;
    const scanPromise = executor.execute(scanPlan, ctx2).then(res => {
      scanCompleted = true;
      return res;
    });

    // Wait a short time to verify it's blocked
    await new Promise(r => setTimeout(r, 100));
    expect(scanCompleted).toBe(false);

    // Commit Txn1, which releases the X lock
    await db.txnManager.commit(txn1.txnId);

    // Now Txn2's scan should complete and see Alice
    const res = await scanPromise;
    expect(scanCompleted).toBe(true);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]).toEqual([1, 'Alice']);

    await db.txnManager.commit(txn2.txnId);
    await db.logManager.close();
  });

  test('Delete + Rollback (Crash Recovery)', async () => {
    const db = await setupDB(tempDir);
    const schema: Schema = [{ name: 'id', type: 'INT', nullable: false }, { name: 'name', type: 'VARCHAR', maxLen: 50, nullable: false }];
    await db.catalog.createTable({
      tableId: 'users' as any, heapFile: 'users.heap', schema, primaryKey: 'id', indexes: {}
    });

    const executor = new Executor();
    
    // Setup: Insert Alice and commit
    const txnSetup = await db.txnManager.begin();
    const ctxSetup: ExecContext = { ...db, txn: txnSetup } as any;
    const insertPlan: PhysInsert = {
      kind: 'phys_insert', tableId: 'users' as any, columns: ['id', 'name'],
      values: [[{ kind: 'bound_literal', value: 1, type: 'INT' }, { kind: 'bound_literal', value: 'Alice', type: 'VARCHAR' }]],
      estRows: 1, estCost: 1
    };
    await executor.execute(insertPlan, ctxSetup);
    await db.txnManager.commit(txnSetup.txnId);

    // Txn1: Delete Alice, but CRASH before commit
    const txn1 = await db.txnManager.begin();
    const ctx1: ExecContext = { ...db, txn: txn1 } as any;
    
    const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'users' as any, schema, estRows: 1, estCost: 1 };
    const deletePlan: PhysDelete = { kind: 'phys_delete', tableId: 'users' as any, child: scanPlan, estRows: 1, estCost: 1 };
    await executor.execute(deletePlan, ctx1);

    // Verify it's deleted in memory
    const verifyEmpty = await executor.execute(scanPlan, ctx1);
    expect(verifyEmpty.rows.length).toBe(0);

    // Simulate crash by dropping all memory state and closing log manager
    await db.logManager.close();

    // Recover
    const db2 = await setupDB(tempDir);
    await recover(db2.logManager, db2.bufferPool, db2.txnManager, tempDir);

    // Verify Alice exists after recovery (rollback of uncommitted delete)
    const executor2 = new Executor();
    const txnVerify = await db2.txnManager.begin();
    const ctxVerify: ExecContext = { ...db2, txn: txnVerify } as any;
    const scanPlan2: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'users' as any, schema, estRows: 1, estCost: 1 };
    
    const finalRes = await executor2.execute(scanPlan2, ctxVerify);
    expect(finalRes.rows.length).toBe(1);
    expect(finalRes.rows[0]).toEqual([1, 'Alice']);

    await db2.txnManager.commit(txnVerify.txnId);
    await db2.logManager.close();
  });
});
