import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';
import { Executor } from '../src/execution/Executor.js';
import { VecProject } from '../src/vectorized/VecProject.js';
import { VecFilter } from '../src/vectorized/VecFilter.js';
import { VecSeqScan } from '../src/vectorized/VecSeqScan.js';
import type { PhysSeqScan, PhysFilter } from '../src/optimizer/PhysicalPlan.js';
import type { Schema } from '../src/common/types.js';
async function runBenchmark() {
  const SIZES = [10_000, 50_000, 100_000];

  for (const n of SIZES) {
    console.log(`\nPreparing dataset of size ${n}...`);
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
    const db = new MiniDB(tempDir, 1000);
    await db.open();
    
    try {
    
    const schema: Schema = [
      { name: 'id', type: 'INT', nullable: false },
      { name: 'age', type: 'INT', nullable: false },
      { name: 'salary', type: 'FLOAT', nullable: false },
      { name: 'name', type: 'VARCHAR', maxLen: 50, nullable: false }
    ];
    await db.catalog.createTable({
      tableId: 'employees' as any,
      heapFile: 'employees.heap',
      schema,
      primaryKey: 'id',
      indexes: {}
    });

    const tableInfo = db.catalog.getTable('employees' as any);
    const txn = await db.txnManager.begin();
    const ctx: ExecContext = { ...db, txn } as any;

    // Seed data
    for (let i = 0; i < n; i++) {
      // 10% chance age > 50
      const age = i % 10 === 0 ? 55 : 30;
      await tableInfo.heapFile.insertTuple([i, age, 50000.5, `Employee_${i}`], schema);
    }
    await db.txnManager.commit(txn.txnId);

    // Plans
    const scanPlan: PhysSeqScan = { kind: 'phys_seq_scan', tableId: 'employees' as any, schema, estRows: n, estCost: 1 };
    const filterPlan: PhysFilter = {
      kind: 'phys_filter',
      child: scanPlan,
      predicate: {
        kind: 'bound_binary',
        op: '>',
        left: { kind: 'bound_col', tableId: 'employees' as any, columnName: 'age', columnIndex: 1, type: 'INT' },
        right: { kind: 'bound_literal', value: 50, type: 'INT' }
      },
      estRows: n * 0.1, estCost: 1
    };
    const projectPlan: PhysProject = {
      kind: 'phys_project',
      child: filterPlan,
      projections: [
        { kind: 'bound_col', tableId: 'employees' as any, columnName: 'name', columnIndex: 3, type: 'VARCHAR' },
        { kind: 'bound_col', tableId: 'employees' as any, columnName: 'salary', columnIndex: 2, type: 'FLOAT' }
      ],
      estRows: n * 0.1, estCost: 1
    };

    // Runners
    const volcanoExecutor = new Executor();
    const runVolcano = async () => {
      const execTxn = await db.txnManager.begin();
      const execCtx = { ...db, txn: execTxn } as any;
      const res = await volcanoExecutor.execute(projectPlan, execCtx);
      await db.txnManager.commit(execTxn.txnId);
      return res.rows.length;
    };

    const runVectorized = async () => {
      const execTxn = await db.txnManager.begin();
      const execCtx = { ...db, txn: execTxn } as any;
      
      const buildChild = (plan: any) => {
        if (plan.kind === 'phys_seq_scan') return new VecSeqScan(plan);
        if (plan.kind === 'phys_filter') return new VecFilter(plan, buildChild);
        throw new Error('Unsupported');
      };
      
      const root = new VecProject(projectPlan, buildChild);
      await root.open(execCtx);
      
      let count = 0;
      while (true) {
        const batch = await root.nextBatch();
        if (!batch) break;
        
        // Sum up surviving rows using selection vector
        for (let i = 0; i < batch.numRows; i++) {
          if (batch.selectionVector[i] === 1) {
            count++;
          }
        }
      }
      
      await root.close();
      await db.txnManager.commit(execTxn.txnId);
      return count;
    };

    // Warmup
    console.log(`Warming up...`);
    for (let i = 0; i < 3; i++) {
      await runVolcano();
      await runVectorized();
    }

    // Benchmark
    const ITERATIONS = 5;
    console.log(`Measuring Volcano over ${ITERATIONS} iterations...`);
    const volStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await runVolcano();
    }
    const volAvg = (performance.now() - volStart) / ITERATIONS;

    console.log(`Measuring Vectorized over ${ITERATIONS} iterations...`);
    const vecStart = performance.now();
    let resCount = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      resCount = await runVectorized();
    }
    const vecAvg = (performance.now() - vecStart) / ITERATIONS;

    console.log(`Rows: ${n.toLocaleString()} | Selected: ${resCount.toLocaleString()}`);
    console.log(`Volcano:    ${volAvg.toFixed(2)} ms`);
    console.log(`Vectorized: ${vecAvg.toFixed(2)} ms`);
    console.log(`Speedup:    ${(volAvg / vecAvg).toFixed(2)}x`);

    } finally {
      await db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

runBenchmark().catch(console.error);
