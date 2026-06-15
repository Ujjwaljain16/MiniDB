import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';

async function runBenchmark() {
  console.log('--- Benchmark 6: Crash Recovery & Idempotence ---');
  
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
  
  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'data', type: 'VARCHAR', maxLen: 50, nullable: false }
  ];

  let db = new MiniDB(tempDir, 100);
  await db.open();

  try {

  await db.catalog.createTable({
    tableId: 'items' as any,
    heapFile: 'items.heap',
    schema,
    primaryKey: 'id',
    indexes: {}
  });

  const tableInfo = db.catalog.getTable('items' as any);

  // Scenario 1: T1 inserts 10,000 rows and COMMITS
  console.log('T1: Inserting 10,000 rows and committing...');
  const t1 = await db.txnManager.begin();
  const ctx1 = { logManager: db.logManager, txn: t1 } as any;
  const insertedRids = [];
  for (let i = 0; i < 10000; i++) {
    const rid = await tableInfo.heapFile.insertTuple([i, `Item_${i}`], schema, ctx1);
    insertedRids.push(rid);
  }
  await db.txnManager.commit(t1.txnId);

  // Ensure catalog changes are flushed
  await db.catalog.flush();

  // Scenario 2: T2 deletes 500 rows but CRASHES (no commit)
  console.log('T2: Deleting 500 rows and CRASHING without commit...');
  const t2 = await db.txnManager.begin();
  const ctx2 = { logManager: db.logManager, txn: t2 } as any;
  for (let i = 0; i < 500; i++) {
    await tableInfo.heapFile.deleteTuple(insertedRids[i]!, ctx2);
  }
  
  // We manually flush the log to ensure T2's log records are on disk to simulate crash timing
  await db.logManager.flush(db.logManager.currentLsn());

  // 🔥 CRASH SIMULATION
  console.log('🔥 SIMULATING SYSTEM CRASH (Destroying in-memory state)...');
  
  // We do NOT flush BufferPool. We just close file handles.
  await db.logManager.close();
  await db.diskManager.close();
  db = null as any;

  // 🛠️ RECOVERY SCENARIO A
  console.log('\n🛠️ RUNNING ARIES CRASH RECOVERY (Scenario A)...');
  db = new MiniDB(tempDir, 100);
  await db.open(); // This natively runs recover()!
  
  // Close again to prepare for Scenario B (repeated recovery)
  await db.close();

  // 🛠️ RECOVERY SCENARIO B (Idempotent Redo)
  console.log('\n🛠️ RE-RUNNING CRASH RECOVERY TO PROVE IDEMPOTENCE (Scenario B)...');
  db = new MiniDB(tempDir, 100);
  await db.open();

  // Validate state
  console.log('\nValidating system state after recovery...');

  const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'items' as any, schema, estRows: 10000, estCost: 1 };
  
  const execTxn = await db.txnManager.begin();
  const ctx = { ...db, txn: execTxn };
  const res = await db.executor.execute(scanPlan, ctx as any);
  await db.txnManager.commit(execTxn.txnId);

  console.log(`Expected Rows: 10000 | Actual Rows: ${res.rows.length}`);
  if (res.rows.length === 10000) {
    console.log('✅ Recovery Successful! Atomicity and Durability proven.');
  } else {
    console.log('❌ Recovery Failed.');
  }

  } finally {
    if (db) await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
