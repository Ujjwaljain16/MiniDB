import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';

describe('Full System Integration: B+Tree Persistence and Recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'integration-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should survive a full system restart with B+Tree indexes and data intact', async () => {
    // 1. First Boot: Initialize DB
    let db = new MiniDB(tempDir);
    await db.open();

    const schema: any = [
      { name: 'id', type: 'INT', nullable: false },
      { name: 'val', type: 'INT', nullable: false }
    ];

    await db.execute('CREATE TABLE users (id INT, val INT)');
    await db.execute('CREATE INDEX idx_users_id ON users (id)');

    // 2. Insert 10,000 rows
    const insertTxn = await db.txnManager.begin();
    const table = db.catalog.getTable('users' as any);
    const index = table.indexes['idx_users_id' as any]!;
    
    // We do bulk load for speed instead of parsing 10k INSERT INTO strings in JS test
    const entries: [any, any][] = [];
    for (let i = 0; i < 10000; i++) {
      const rid = await table.heapFile.insertTuple([i, i * 2], schema, { txn: insertTxn, logManager: db.logManager } as any);
      entries.push([i, rid]);
    }
    await index.tree.bulkLoad(entries);
    await db.txnManager.commit(insertTxn.txnId);

    // Update stats so optimizer uses index
    await db.catalog.updateStats('users' as any, {
      rowCount: 10000,
      columnStats: {
        id: { nDistinct: 10000, min: 0, max: 9999 },
        val: { nDistinct: 10000, min: 0, max: 19998 }
      }
    });

    await db.catalog.flush();

    // Verify index works before shutdown
    const res1 = await db.execute('SELECT * FROM users WHERE id = 5000');
    expect(res1.rows.length).toBe(1);
    expect(res1.rows[0]![1]).toBe(10000);

    // 3. System Shutdown (Simulated)
    await db.close();
    db = null as any;

    // 4. Second Boot: Recover DB
    let recoveredDb = new MiniDB(tempDir);
    await recoveredDb.open();

    // 5. Verify catalog loaded correctly
    const recoveredTable = recoveredDb.catalog.getTable('users' as any);
    expect(recoveredTable).toBeDefined();
    expect(recoveredTable.indexes['idx_users_id' as any]).toBeDefined();

    // 6. Verify B+Tree Root persisted
    const recoveredIndex = recoveredTable.indexes['idx_users_id' as any]!;
    expect(recoveredIndex.rootPageId).toBeGreaterThan(0); // Should not be -1

    // 7. Verify SELECT returns correct rows using the recovered index
    const res2 = await recoveredDb.execute('EXPLAIN SELECT * FROM users WHERE id = 5000');
    // Optimizer should have chosen IndexScan
    expect(JSON.stringify(res2.rows)).toContain('phys_index_scan');

    const res3 = await recoveredDb.execute('SELECT * FROM users WHERE id = 5000');
    expect(res3.rows.length).toBe(1);
    expect(res3.rows[0]![1]).toBe(10000);

    await recoveredDb.close();
  });
});
