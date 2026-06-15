import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';

describe('SQL Fuzz Testing', () => {
  let tempDir: string;
  let db: MiniDB;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'fuzz-'));
    db = new MiniDB(tempDir);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maintains consistency against a reference Map over 1000 random operations', async () => {
    await db.execute('CREATE TABLE fuzz (id INT, val INT)');
    
    const reference = new Map<number, number>();
    const NUM_OPS = 1000;
    
    // We'll limit the ID space so we get a good mix of inserts, updates (handled as deletes + inserts in our test), and deletes
    const MAX_ID = 100;

    for (let i = 0; i < NUM_OPS; i++) {
      const op = Math.random();
      const id = Math.floor(Math.random() * MAX_ID);
      const val = Math.floor(Math.random() * 10000);

      if (op < 0.6) { // 60% Insert or Replace
        if (reference.has(id)) {
          // MiniDB doesn't have UPDATE yet, so we emulate REPLACE by DELETE + INSERT
          await db.execute(`DELETE FROM fuzz WHERE id = ${id}`);
        }
        await db.execute(`INSERT INTO fuzz VALUES (${id}, ${val})`);
        reference.set(id, val);
      } else if (op < 0.8) { // 20% Delete
        await db.execute(`DELETE FROM fuzz WHERE id = ${id}`);
        reference.delete(id);
      } else { // 20% Point Select
        const res = await db.execute(`SELECT * FROM fuzz WHERE id = ${id}`);
        if (reference.has(id)) {
          expect(res.rows.length).toBe(1);
          expect(res.rows[0]![1]).toBe(reference.get(id));
        } else {
          expect(res.rows.length).toBe(0);
        }
      }
    }

    // Final full scan comparison
    const finalScan = await db.execute('SELECT * FROM fuzz');
    const dbMap = new Map<number, number>();
    for (const row of finalScan.rows) {
      dbMap.set(row[0] as number, row[1] as number);
    }

    expect(dbMap.size).toBe(reference.size);
    for (const [k, v] of reference.entries()) {
      expect(dbMap.get(k)).toBe(v);
    }
  }, 30000); // Give it up to 30 seconds
});
