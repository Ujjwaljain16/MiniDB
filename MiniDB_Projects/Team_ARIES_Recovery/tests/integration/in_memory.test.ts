import { MiniDB } from '../../src/MiniDB.js';
import { MemDiskManager } from '../../src/storage/MemDiskManager.js';
import { MemLogManager } from '../../src/recovery/MemLogManager.js';
import { LogManager } from '../../src/recovery/LogManager.js';
import { PAGE_SIZE } from '../../src/common/config.js';
import type { PageId, TxnId, LSN } from '../../src/common/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('MiniDB.inMemory', () => {
  let db: MiniDB;

  beforeEach(async () => {
    db = await MiniDB.inMemory({ poolSize: 8 });
  });

  afterEach(async () => {
    await db.close();
  });

  // The browser-bundle smoke test covers "no fs": there every Node builtin is a stub that throws.
  it('runs DDL, DML and queries', async () => {
    await db.execute('CREATE TABLE users (id INT, name VARCHAR)');
    await db.execute('CREATE TABLE orders (oid INT, uid INT)');
    const pad = 'x'.repeat(40);
    for (let i = 1; i <= 600; i++) {
      await db.execute(`INSERT INTO users VALUES (${i}, 'user${i}${pad}')`);
      if (i % 3 === 0) await db.execute(`INSERT INTO orders VALUES (${i}, ${i})`);
    }
    await db.execute('CREATE INDEX idx_users_id ON users (id)');

    expect((await db.execute('SELECT * FROM users')).rows.length).toBe(600);
    expect((await db.execute('SELECT * FROM orders')).rows.length).toBe(200);
    expect((await db.execute('SELECT * FROM users WHERE id = 42')).rows).toEqual([[42, `user42${pad}`]]);

    await db.execute('DELETE FROM users WHERE id > 550');
    expect((await db.execute('SELECT * FROM users')).rows.length).toBe(550);
    expect((await db.execute('SELECT * FROM orders')).rows.length).toBe(200);

    const pool = await db.execute('SHOW BUFFER_POOL');
    const stats = Object.fromEntries(pool.rows as [string, number][]);
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.evictions).toBeGreaterThan(0); // 8 frames are not enough for both tables

    const wal = await db.execute('SHOW WAL');
    expect(wal.columns).toEqual(['LSN', 'TxnId', 'Type', 'PrevLSN']);
    expect(wal.rows.length).toBe(100); // SHOW WAL returns the tail
    const types = wal.rows.map(r => r[2]);
    expect(types.filter(t => t === 'DELETE').length).toBe(50);
    expect(types).toContain('BEGIN');
    expect(types).toContain('COMMIT');
    const lsns = wal.rows.map(r => r[0] as number);
    expect(lsns).toEqual([...lsns].sort((a, b) => a - b));
    expect(lsns[lsns.length - 1]).toBeLessThan(db.logManager.currentLsn() as unknown as number);
  });

  it('does not start the deadlock detector', () => {
    expect(db.deadlockDetector).toBeUndefined();
  });
});

describe('MemDiskManager', () => {
  it('copies pages in and out instead of sharing buffers', async () => {
    const disk = new MemDiskManager();
    const id = await disk.allocatePage();
    expect(id).toBe(0);
    expect(disk.getPageCount()).toBe(1);

    const out = Buffer.alloc(PAGE_SIZE, 7);
    await disk.writePage(id, out);
    out.fill(9);

    const back = Buffer.alloc(PAGE_SIZE);
    await disk.readPage(id, back);
    expect(back.every(b => b === 7)).toBe(true);
    back.fill(1);

    const again = Buffer.alloc(PAGE_SIZE);
    await disk.readPage(id, again);
    expect(again[0]).toBe(7);

    const past = Buffer.alloc(PAGE_SIZE, 5);
    await disk.readPage(5 as PageId, past);
    expect(past.every(b => b === 0)).toBe(true);
  });
});

describe('MemLogManager', () => {
  it('assigns the same byte-offset LSNs as the file log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidb-memlog-'));
    const fileLog = new LogManager(path.join(dir, 'wal.log'));
    await fileLog.init();
    const memLog = new MemLogManager();
    try {
      const records = [
        { txnId: 1 as TxnId, type: 'BEGIN' as const, prevLsn: -1 as unknown as LSN },
        { txnId: 1 as TxnId, type: 'INSERT' as const, prevLsn: 0 as unknown as LSN, tableId: 't' as any,
          rid: { pageId: 1 as PageId, slotId: 0 as any }, afterImage: Buffer.from([1, 2, 3]) },
        { txnId: 1 as TxnId, type: 'COMMIT' as const, prevLsn: 0 as unknown as LSN },
      ];
      const fileLsns = [];
      const memLsns = [];
      for (const r of records) {
        fileLsns.push(await fileLog.append(r));
        memLsns.push(await memLog.append(r));
      }
      expect(memLsns).toEqual(fileLsns);
      expect(memLog.currentLsn()).toBe(fileLog.currentLsn());

      const fromSecond = [];
      for await (const r of memLog.iterator(memLsns[1]!)) fromSecond.push(r.type);
      expect(fromSecond).toEqual(['INSERT', 'COMMIT']);

      const all = [];
      for await (const r of memLog.iterator(0 as unknown as LSN)) all.push(r);
      expect(all[1]!.afterImage).toEqual(Buffer.from([1, 2, 3]));
      expect(all.map(r => r.lsn)).toEqual(memLsns);
    } finally {
      await fileLog.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
