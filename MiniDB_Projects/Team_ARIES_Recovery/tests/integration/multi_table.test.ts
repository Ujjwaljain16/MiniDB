import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';

describe('Multiple tables share one data file without mixing rows', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'multi-table-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function rows(db: MiniDB, table: string): Promise<unknown[][]> {
    const res = await db.execute(`SELECT * FROM ${table}`);
    return res.rows.slice().sort((a, b) => (a[0] as number) - (b[0] as number));
  }

  it('keeps two tables apart with interleaved inserts', async () => {
    const db = new MiniDB(tempDir);
    await db.open();
    try {
      await db.execute('CREATE TABLE t (id INT, name VARCHAR, age INT)');
      await db.execute('CREATE TABLE u (x INT)');
      await db.execute('INSERT INTO u VALUES (9)');
      await db.execute("INSERT INTO t VALUES (1, 'a', 2)");
      await db.execute('INSERT INTO u VALUES (10)');
      await db.execute("INSERT INTO t VALUES (2, 'b', 3)");

      expect(await rows(db, 't')).toEqual([[1, 'a', 2], [2, 'b', 3]]);
      expect(await rows(db, 'u')).toEqual([[9], [10]]);
    } finally {
      await db.close();
    }
  });

  it('keeps three tables apart across many pages, deletes and a restart', async () => {
    let db = new MiniDB(tempDir, 16);
    await db.open();
    const expected: Record<string, number[]> = { a: [], b: [], c: [] };
    try {
      await db.execute('CREATE TABLE a (id INT, pad VARCHAR)');
      await db.execute('CREATE TABLE b (id INT, flag BOOL, score FLOAT)');
      await db.execute('CREATE TABLE c (id INT)');

      const pad = 'x'.repeat(200); // forces table a onto several pages
      for (let i = 0; i < 60; i++) {
        await db.execute(`INSERT INTO a VALUES (${i}, '${pad}')`);
        await db.execute(`INSERT INTO b VALUES (${i}, true, ${i}.5)`);
        await db.execute(`INSERT INTO c VALUES (${i})`);
        expected.a!.push(i);
        expected.b!.push(i);
        expected.c!.push(i);
      }
      await db.execute('DELETE FROM a WHERE id < 10');
      await db.execute('DELETE FROM c WHERE id > 49');
      expected.a = expected.a!.filter(i => i >= 10);
      expected.c = expected.c!.filter(i => i <= 49);
      for (let i = 100; i < 105; i++) {
        await db.execute(`INSERT INTO c VALUES (${i})`);
        await db.execute(`INSERT INTO a VALUES (${i}, 'y')`);
        expected.c!.push(i);
        expected.a!.push(i);
      }

      for (const t of ['a', 'b', 'c']) {
        expect((await rows(db, t)).map(r => r[0])).toEqual(expected[t]);
      }
      const b = await rows(db, 'b');
      expect(b[5]).toEqual([5, true, 5.5]);
    } finally {
      await db.close();
    }

    db = new MiniDB(tempDir, 16);
    await db.open();
    try {
      for (const t of ['a', 'b', 'c']) {
        expect((await rows(db, t)).map(r => r[0])).toEqual(expected[t]);
      }
    } finally {
      await db.close();
    }
  });

  it('recovers two tables whose pages never reached disk', async () => {
    const db = new MiniDB(tempDir);
    await db.open();
    await db.execute('CREATE TABLE t (id INT, name VARCHAR)');
    await db.execute('CREATE TABLE u (x INT)');
    for (let i = 0; i < 5; i++) {
      await db.execute(`INSERT INTO u VALUES (${i * 10})`);
      await db.execute(`INSERT INTO t VALUES (${i}, 'n${i}')`);
    }
    // An uncommitted insert into each table must be undone
    const txn = await db.txnManager.begin();
    await db.execute('INSERT INTO t VALUES (99, \'loser\')', txn.txnId);
    await db.execute('INSERT INTO u VALUES (999)', txn.txnId);

    // Crash: WAL is on disk, data pages are not
    db.deadlockDetector.stop();
    await db.logManager.flush(db.logManager.currentLsn());
    await db.logManager.close();
    await db.diskManager.close();

    const db2 = new MiniDB(tempDir);
    await db2.open();
    try {
      expect(await rows(db2, 't')).toEqual([0, 1, 2, 3, 4].map(i => [i, `n${i}`]));
      expect(await rows(db2, 'u')).toEqual([[0], [10], [20], [30], [40]]);
      await db2.execute('INSERT INTO u VALUES (50)');
      expect((await rows(db2, 'u')).length).toBe(6);
      expect((await rows(db2, 't')).length).toBe(5);
    } finally {
      await db2.close();
    }
  });

  it('does not hand a dropped table\'s pages to a new table', async () => {
    let db = new MiniDB(tempDir);
    await db.open();
    try {
      // old is created last so a new table could inherit its id after the drop
      await db.execute('CREATE TABLE keep (id INT)');
      await db.execute('CREATE TABLE old (id INT)');
      for (let i = 0; i < 5; i++) {
        await db.execute(`INSERT INTO old VALUES (${i})`);
        await db.execute(`INSERT INTO keep VALUES (${i + 100})`);
      }
      await db.catalog.dropTable('old' as any);
      await db.execute('CREATE TABLE fresh (id INT)');
      expect(await rows(db, 'fresh')).toEqual([]);
      await db.execute('INSERT INTO fresh VALUES (7)');
      expect(await rows(db, 'fresh')).toEqual([[7]]);
      expect((await rows(db, 'keep')).length).toBe(5);
    } finally {
      await db.close();
    }

    db = new MiniDB(tempDir);
    await db.open();
    try {
      expect(await rows(db, 'fresh')).toEqual([[7]]);
      expect((await rows(db, 'keep')).map(r => r[0])).toEqual([100, 101, 102, 103, 104]);
    } finally {
      await db.close();
    }
  });
});
