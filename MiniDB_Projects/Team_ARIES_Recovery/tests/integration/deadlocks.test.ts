import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';
import { LockMode } from '../../src/common/interfaces.js';

describe('Concurrency & Deadlocks', () => {
  let tempDir: string;
  let db: MiniDB;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'deadlocks-'));
    db = new MiniDB(tempDir);
    await db.open();
    // Use manual transactions for precise locking
    await db.execute('CREATE TABLE deadlocks (id INT, val INT)');
    await db.execute('INSERT INTO deadlocks VALUES (1, 100)');
    await db.execute('INSERT INTO deadlocks VALUES (2, 200)');
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects and resolves a simple cycle (A -> B, B -> A)', async () => {
    const t1 = await db.txnManager.begin();
    const t2 = await db.txnManager.begin();

    const ridA = { pageId: 0, slotId: 1 } as any;
    const ridB = { pageId: 0, slotId: 2 } as any;

    // T1 acquires X(A)
    await db.lockManager.acquireRowLock(t1.txnId, ridA, LockMode.X);
    
    // T2 acquires X(B)
    await db.lockManager.acquireRowLock(t2.txnId, ridB, LockMode.X);

    // T1 tries to acquire X(B) - this will block
    const p1 = db.lockManager.acquireRowLock(t1.txnId, ridB, LockMode.X).catch(e => {});

    // T2 tries to acquire X(A) - this will block and complete the cycle
    const p2 = db.lockManager.acquireRowLock(t2.txnId, ridA, LockMode.X).catch(e => {});

    // Give the deadlock detector a moment to run (it runs every DEADLOCK_CHECK_INTERVAL_MS = 100ms)
    await new Promise(r => setTimeout(r, 200));

    // One of them must have been aborted
    let t1Aborted = t1.state === 'ABORTED';
    let t2Aborted = t2.state === 'ABORTED';
    
    expect(t1Aborted !== t2Aborted).toBe(true); // Exactly one was aborted
    
    // The youngest victim is aborted, which should be t2
    expect(t2Aborted).toBe(true);

    try { await p1; } catch (e) {}
    try { await p2; } catch (e) {}

    if (!t1Aborted) await db.txnManager.commit(t1.txnId);
    if (!t2Aborted) await db.txnManager.commit(t2.txnId);
  });

  it('detects lock upgrade deadlocks (T1 S(A)->X(A), T2 S(A)->X(A))', async () => {
    const t1 = await db.txnManager.begin();
    const t2 = await db.txnManager.begin();

    const ridA = { pageId: 0, slotId: 1 } as any;

    // T1 acquires S(A)
    await db.lockManager.acquireRowLock(t1.txnId, ridA, LockMode.S);
    
    // T2 acquires S(A) - compatible
    await db.lockManager.acquireRowLock(t2.txnId, ridA, LockMode.S);

    // T1 tries to upgrade to X(A) - blocks because T2 has S(A)
    const p1 = db.lockManager.acquireRowLock(t1.txnId, ridA, LockMode.X).catch(e => {});

    // T2 tries to upgrade to X(A) - blocks because T1 has S(A), creating a deadlock
    // LockManager explicitly throws Error("Deadlock avoided: Multiple concurrent upgrades")
    let p2Error: any = null;
    try {
      await db.lockManager.acquireRowLock(t2.txnId, ridA, LockMode.X);
    } catch (err) {
      p2Error = err;
    }

    expect(p2Error).toBeDefined();
    expect(p2Error.message).toContain('Deadlock avoided');

    // p1 should eventually be granted once t2 is aborted or releases locks, but for this test we manually abort t2
    await db.txnManager.abort(t2.txnId);
    
    // now p1 should resolve
    await p1;

    await db.txnManager.commit(t1.txnId);
  });
});
