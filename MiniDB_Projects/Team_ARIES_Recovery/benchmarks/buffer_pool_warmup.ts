import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';
import { Executor } from '../src/execution/Executor.js';
import type { PhysSeqScan, PhysFilter } from '../src/optimizer/PhysicalPlan.js';
import type { Schema } from '../src/common/types.js';
async function runBenchmark() {
  console.log('--- Benchmark 2: Buffer Pool Cold vs Warm Cache ---');
  console.log('Goal: Show how storage hierarchy and caching accelerates sequential reads.\n');
  
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
  // Pool size of 100 pages = 400KB cache
  const db = new MiniDB(tempDir, 100);
  await db.open();

  try {
  
  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'payload', type: 'VARCHAR', maxLen: 100, nullable: false }
  ];
  
  await db.catalog.createTable({
    tableId: 'large_table' as any,
    heapFile: 'large_table.heap',
    schema,
    primaryKey: 'id',
    indexes: {}
  });

  const tableInfo = db.catalog.getTable('large_table' as any);
  const txn = await db.txnManager.begin();
  
  console.log('Seeding table to exceed 100 pages (approx 10,000 rows)...');
  for (let i = 0; i < 10000; i++) {
    await tableInfo.heapFile.insertTuple([i, `Payload_Data_${i}_padding_to_make_row_larger`], schema);
  }
  await db.txnManager.commit(txn.txnId);

  // We need to restart the DB to truly have a COLD cache
  await db.close();

  // Re-open DB
  const db2 = new MiniDB(tempDir, 1000); // 1000 pages to fit everything
  await db2.open();
  
  try {
  
  const executor = new Executor();
  const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'large_table' as any, schema, estRows: 10000, estCost: 10000 };
  const filterPlan: PhysFilter = {
    kind: 'phys_filter',
    child: scanPlan,
    predicate: {
      kind: 'bound_binary',
      op: '=',
      left: { kind: 'bound_col', tableId: 'large_table' as any, columnName: 'id', columnIndex: 0, type: 'INT' },
      right: { kind: 'bound_literal', value: -1, type: 'INT' } // Matches nothing
    },
    estRows: 1, estCost: 10000
  };

  const runPhase = async (phaseName: string) => {
    const execTxn = await db2.txnManager.begin();
    const ctx: ExecContext = { ...db2, txn: execTxn } as any;
    
    // Clear stats
    (db2.bufferPool as any).statsCounters = { hits: 0, misses: 0, evictions: 0 };
    
    const startTime = performance.now();
    await executor.execute(filterPlan, ctx);
    const elapsed = performance.now() - startTime;
    await db2.txnManager.commit(execTxn.txnId);

    const stats = db2.bufferPool.stats();
    console.log(`\nPhase: ${phaseName}`);
    console.log(`Latency: ${elapsed.toFixed(2)} ms`);
    console.log(`Hits: ${stats.hits} | Misses: ${stats.misses}`);
    const hitRate = stats.hits + stats.misses > 0 ? (stats.hits / (stats.hits + stats.misses)) * 100 : 0;
    console.log(`Hit Rate: ${hitRate.toFixed(2)}%`);
  };

  await runPhase('Phase A: Cold Start (Reading from disk)');
  await runPhase('Phase B: Warm Cache (Reading from memory)');

  // Phase C: Cache Pollution
  console.log('\nPolluting cache with a massive sequential scan...');
  
  await db2.catalog.createTable({
    tableId: 'pollution_table' as any,
    heapFile: 'pollution_table.heap',
    schema,
    primaryKey: 'id',
    indexes: {}
  });
  const pollInfo = db2.catalog.getTable('pollution_table' as any);
  const pollTxn = await db2.txnManager.begin();
  for (let i = 0; i < 20000; i++) {
    await pollInfo.heapFile.insertTuple([i, `Pollution_${i}`], schema);
  }
  await db2.txnManager.commit(pollTxn.txnId);

  const pollScanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'pollution_table' as any, schema, estRows: 20000, estCost: 20000 };
  const pollFilterPlan: PhysFilter = { ...filterPlan, child: pollScanPlan };
  
  const pTxn = await db2.txnManager.begin();
  await executor.execute(pollFilterPlan, { ...db2, txn: pTxn } as any);
  await db2.txnManager.commit(pTxn.txnId);

  await runPhase('Phase C: Post-Pollution (Cache was evicted)');

  } finally {
    await db2.close();
  }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
