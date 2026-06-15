import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';

describe('Crash Recovery Matrix', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'crash-matrix-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function crashDb(db: MiniDB) {
    // 1. Stop background tasks
    if (db.deadlockDetector) {
      db.deadlockDetector.stop();
    }
    // 2. DO NOT flush buffer pool! This is the crash.
    // 3. Just close the file descriptors so we can re-open on Windows.
    if (db.logManager) {
      // Force a final flush so our WAL is physically on disk as it would be if OS synced,
      // but without the DB committing cleanly. (Or we don't flush to simulate power loss).
      // We will flush the WAL up to current LSN to simulate "WAL reached disk but pages didn't".
      await db.logManager.flush(db.logManager.currentLsn());
      await db.logManager.close();
    }
    if (db.diskManager) {
      await db.diskManager.close();
    }
  }

  it('INSERT after WAL before page flush -> redo restores', async () => {
    // Setup
    let db = new MiniDB(tempDir);
    await db.open();
    await db.execute('CREATE TABLE crash1 (id INT, val INT)');

    // Commit a transaction to ensure table creation is durable
    let res = await db.execute('INSERT INTO crash1 VALUES (1, 100)');

    // Force dirty pages to not be flushed, crash the DB
    await crashDb(db);

    // Recover
    let db2 = new MiniDB(tempDir);
    await db2.open();
    let res2 = await db2.execute('SELECT * FROM crash1');
    expect(res2.rows.length).toBe(1);
    expect(res2.rows[0]![1]).toBe(100);
    await db2.close();
  });

  it('DELETE before commit -> undo restores', async () => {
    let db = new MiniDB(tempDir);
    await db.open();
    await db.execute('CREATE TABLE crash2 (id INT, val INT)');
    await db.execute('INSERT INTO crash2 VALUES (1, 100)');
    await db.close(); // Cleanly save the initial state

    db = new MiniDB(tempDir);
    await db.open();
    // Begin a txn, delete, but DO NOT commit
    const txn = await db.txnManager.begin();
    await db.execute('DELETE FROM crash2 WHERE id = 1', txn.txnId);
    
    // Check it's gone in current session
    let res = await db.execute('SELECT * FROM crash2', txn.txnId);
    expect(res.rows.length).toBe(0);

    // Crash before commit!
    await crashDb(db);

    // Recover
    let db2 = new MiniDB(tempDir);
    await db2.open();
    // Undo should have restored the deleted row
    let res2 = await db2.execute('SELECT * FROM crash2');
    expect(res2.rows.length).toBe(1);
    expect(res2.rows[0]![1]).toBe(100);
    await db2.close();
  });

  it('COMMIT after WAL flush before ACK -> transaction survives', async () => {
    let db = new MiniDB(tempDir);
    await db.open();
    await db.execute('CREATE TABLE crash3 (id INT, val INT)');

    const txn = await db.txnManager.begin();
    await db.execute('INSERT INTO crash3 VALUES (2, 200)', txn.txnId);
    
    // Manually write commit record and flush WAL, but do not flush buffer pool
    await db.logManager.append({
      txnId: txn.txnId,
      type: 'COMMIT',
      prevLsn: txn.prevLsn
    });
    await db.logManager.flush(db.logManager.currentLsn());
    
    // Crash before db.txnManager.commit finishes!
    await crashDb(db);

    // Recover
    let db2 = new MiniDB(tempDir);
    await db2.open();
    // Transaction should survive because COMMIT was in WAL
    let res2 = await db2.execute('SELECT * FROM crash3');
    expect(res2.rows.length).toBe(1);
    expect(res2.rows[0]![1]).toBe(200);
    await db2.close();
  });
});
