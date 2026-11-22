import { MiniDB } from '../../src/MiniDB.js';
import * as fs from 'fs';
import * as path from 'path';

describe('CREATE INDEX on a table that already has rows', () => {
  let tempDir: string;
  let db: MiniDB;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'index-backfill-'));
    db = new MiniDB(tempDir);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes the existing rows', async () => {
    await db.execute('CREATE TABLE users (id INT, name VARCHAR)');
    await db.execute('CREATE TABLE other (id INT)');
    // Enough rows that the cost model prefers the index for a point lookup
    for (let start = 1; start <= 600; start += 50) {
      const ids = Array.from({ length: 50 }, (_, k) => start + k);
      await db.execute(`INSERT INTO users VALUES ${ids.map(i => `(${i}, 'u${i}')`).join(', ')}`);
      await db.execute(`INSERT INTO other VALUES ${ids.map(i => `(${i + 1000})`).join(', ')}`);
    }
    await db.execute('INSERT INTO users VALUES (NULL, \'nobody\')');
    await db.execute('CREATE INDEX idx_users_id ON users (id)');

    const tree = db.catalog.getTable('users' as any).indexes['idx_users_id' as any].tree;
    for (const id of [1, 77, 600]) {
      const rid = await tree.search(id);
      expect(rid).not.toBeNull();
      expect(await db.catalog.getTable('users' as any).heapFile.getTuple(rid, [
        { name: 'id', type: 'INT', nullable: true },
        { name: 'name', type: 'VARCHAR', nullable: true },
      ])).toEqual([id, `u${id}`]);
    }
    expect(await tree.search(1001)).toBeNull();

    await db.execute('ANALYZE users');
    const plan = await db.execute('EXPLAIN SELECT * FROM users WHERE id = 77');
    expect(JSON.stringify(plan.rows)).toContain('phys_index_scan');
    const res = await db.execute('SELECT * FROM users WHERE id = 77');
    expect(res.rows).toEqual([[77, 'u77']]);
  });
});
