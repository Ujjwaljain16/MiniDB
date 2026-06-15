import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';
import { Executor } from '../src/execution/Executor.js';
import type { PhysSeqScan, PhysIndexScan } from '../src/optimizer/PhysicalPlan.js';
import type { Schema } from '../src/common/types.js';
async function runBenchmark() {
  const SIZES = [10_000, 50_000, 100_000];

  for (const n of SIZES) {
    console.log(`\nPreparing dataset of size ${n}...`);
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
    const db = new MiniDB(tempDir);
    await db.open();
    
    try {
    
    const schema: Schema = [
      { name: 'id', type: 'INT', nullable: false },
      { name: 'name', type: 'VARCHAR', maxLen: 50, nullable: false },
      { name: 'age', type: 'INT', nullable: false }
    ];
    await db.catalog.createTable({
      tableId: 'users' as any,
      heapFile: 'users.heap',
      schema,
      primaryKey: 'id',
      indexes: {}
    });

    const tableInfo = db.catalog.getTable('users' as any);
    const txn = await db.txnManager.begin();
    
    // Seed data
    const entries: [any, RID][] = [];
    for (let i = 0; i < n; i++) {
      const rid = await tableInfo.heapFile.insertTuple([i, `User_${i}`, 20 + (i % 50)], schema);
      entries.push([i, rid]);
    }

    await db.txnManager.commit(txn.txnId);

    // Run SeqScan queries
    const targetId = Math.floor(n / 2);
    const executor = new Executor();

    const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'users' as any, schema, estRows: n, estCost: n };
    const filterPlan: PhysFilter = {
      kind: 'phys_filter',
      child: scanPlan,
      predicate: {
        kind: 'bound_binary',
        op: '=',
        left: { kind: 'bound_col', tableId: 'users' as any, columnName: 'id', columnIndex: 0, type: 'INT' },
        right: { kind: 'bound_literal', value: targetId, type: 'INT' }
      },
      estRows: 1, estCost: n
    };

    const runPlan = async (plan: any) => {
      const execTxn = await db.txnManager.begin();
      const ctx: ExecContext = { ...db, txn: execTxn } as any;
      const startStats = db.bufferPool.stats();
      const startTime = performance.now();
      
      const res = await executor.execute(plan, ctx);
      
      const elapsed = performance.now() - startTime;
      const endStats = db.bufferPool.stats();
      await db.txnManager.commit(execTxn.txnId);

      const pagesRead = (endStats.hits + endStats.misses) - (startStats.hits + startStats.misses);
      return { elapsed, pagesRead, found: res.rows.length };
    };

    console.log(`Query: SELECT * FROM users WHERE id = ${targetId}`);
    
    // Create Index
    await db.catalog.createIndex('users' as any, {
      indexId: 'users_id_idx' as any,
      type: 'btree',
      column: 'id',
      indexFile: 'users_id_idx.tree',
      rootPageId: -1 // Will be allocated
    });

    const indexInfo = tableInfo.indexes['users_id_idx'];
    // Bulk load index
    const loadTxn = await db.txnManager.begin();
    await indexInfo.tree.bulkLoad(entries);
    await db.txnManager.commit(loadTxn.txnId);

    const indexPlan: PhysIndexScan = {
      kind: 'phys_index_scan',
      tableId: 'users' as any,
      indexId: 'users_id_idx' as any,
      schema,
      key: targetId,
      estRows: 1, estCost: Math.log2(n)
    };

    // Run benchmark 3 times and average
    const ITERATIONS = 3;
    let seqAvgTime = 0;
    let idxAvgTime = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      // Warm up
      await runPlan(filterPlan);
      const seqResult = await runPlan(filterPlan);
      seqAvgTime += seqResult.elapsed;
      
      await runPlan(indexPlan);
      const idxResult = await runPlan(indexPlan);
      idxAvgTime += idxResult.elapsed;
    }

    seqAvgTime /= ITERATIONS;
    idxAvgTime /= ITERATIONS;

    console.log(`SeqScan (Avg over ${ITERATIONS} runs): ${seqAvgTime.toFixed(2)} ms`);
    console.log(`B+ Tree (Avg over ${ITERATIONS} runs): ${idxAvgTime.toFixed(2)} ms`);
    console.log(`Speedup: ${(seqAvgTime / idxAvgTime).toFixed(2)}x`);

    } finally {
      await db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

runBenchmark().catch(console.error);
