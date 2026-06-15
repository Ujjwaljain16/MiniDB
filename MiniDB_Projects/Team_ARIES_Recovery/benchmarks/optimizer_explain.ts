import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';
import { parseSQL } from '../src/sql/Parser.js';
import { Binder } from '../src/sql/Binder.js';
import { PhysicalPlanner } from '../src/optimizer/PhysicalPlanner.js';
import { explainTree } from '../src/optimizer/Explain.js';
async function runBenchmark() {
  console.log('--- Benchmark 4: Optimizer Plan Selection ---');
  console.log('Goal: Show that the Cost-Based Optimizer chooses the correct physical path.\n');
  
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
  const db = new MiniDB(tempDir, 100);
  await db.open();
  
  try {
  
  const schema: Schema = [
    { name: 'id', type: 'INT', nullable: false },
    { name: 'age', type: 'INT', nullable: false }
  ];
  
  await db.catalog.createTable({
    tableId: 'users' as any,
    heapFile: 'users.heap',
    schema,
    primaryKey: 'id',
    indexes: {}
  });

  await db.catalog.createIndex('users' as any, {
    indexId: 'users_id_idx' as any,
    type: 'btree',
    column: 'id',
    indexFile: 'users_id_idx.tree',
    rootPageId: -1
  });

  // Inject some fake stats to simulate a large table
  await db.catalog.updateStats('users' as any, {
    rowCount: 100_000,
    columnStats: {
      id: { nDistinct: 100_000, min: 1, max: 100_000 },
      age: { nDistinct: 80, min: 18, max: 98 }
    }
  });

  // We can just use the db's internal binder/planner
  const binder = db.binder;
  const planner = db.planner;

  const explainQuery = (sql: string) => {
    console.log(`Query: ${sql}`);
    const ast = parseSQL(sql);
    const logicalPlan = binder.bindSelect(ast as any);
    const physicalPlan = planner.plan(logicalPlan);
    console.log(explainTree(physicalPlan));
  };

  explainQuery('SELECT * FROM users WHERE id = 100');
  explainQuery('SELECT * FROM users WHERE age > 18');

  } finally {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
