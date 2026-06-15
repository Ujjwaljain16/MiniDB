import fs from 'fs';
import path from 'path';
import { MiniDB } from '../src/MiniDB.js';
import { LockMode } from '../src/common/interfaces.js';

async function runBenchmark() {
  console.log('--- Benchmark 5: Strict 2PL Concurrency & Deadlocks ---');
  
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'benchmark-'));
  const db = new MiniDB(tempDir, 100);
  await db.open();

  // MiniDB auto-starts DeadlockDetector on 1000ms. For tests, we can restart it faster if we want, or just wait.
  db.deadlockDetector.stop();
  const { DeadlockDetector } = await import('../src/concurrency/DeadlockDetector.js');
  db.deadlockDetector = new DeadlockDetector(db.lockManager, db.txnManager, 50);
  db.deadlockDetector.start();

  try {
  console.log('\nScenario A: Strict 2PL Blocking');
  const t1 = await db.txnManager.begin();
  const t2 = await db.txnManager.begin();
  
  const ridUser10 = { pageId: 1, slotId: 10 };
  
  console.log(`[T1] Acquiring X lock on User 10...`);
  await db.lockManager.acquireRowLock(t1.txnId, ridUser10, LockMode.X);
  console.log(`[T1] X lock acquired.`);

  let t2Finished = false;
  const t2Promise = (async () => {
    console.log(`[T2] Attempting to acquire S lock on User 10 (should block)...`);
    await db.lockManager.acquireRowLock(t2.txnId, ridUser10, LockMode.S);
    console.log(`[T2] S lock acquired!`);
    t2Finished = true;
    await db.txnManager.commit(t2.txnId);
  })();

  // Let event loop run to ensure T2 is blocked
  await new Promise(r => setTimeout(r, 100));
  console.log(`[Main] Is T2 finished? ${t2Finished} (Expected: false)`);
  
  console.log(`[T1] Committing, releasing X lock...`);
  await db.txnManager.commit(t1.txnId);
  
  // T2 should now complete
  await t2Promise;
  console.log(`[Main] Is T2 finished? ${t2Finished} (Expected: true)`);


  console.log('\nScenario B: Deadlock Detection');
  const t3 = await db.txnManager.begin();
  const t4 = await db.txnManager.begin();
  const ridA = { pageId: 2, slotId: 1 };
  const ridB = { pageId: 2, slotId: 2 };

  console.log(`[T3 (older)] Acquiring X lock on A...`);
  await db.lockManager.acquireRowLock(t3.txnId, ridA, LockMode.X);
  console.log(`[T4 (younger)] Acquiring X lock on B...`);
  await db.lockManager.acquireRowLock(t4.txnId, ridB, LockMode.X);

  const t3Promise = (async () => {
    try {
      console.log(`[T3] Attempting to acquire X lock on B (waits for T4)...`);
      await db.lockManager.acquireRowLock(t3.txnId, ridB, LockMode.X);
      console.log(`[T3] Acquired X lock on B!`);
      await db.txnManager.commit(t3.txnId);
    } catch (e: any) {
      console.log(`[T3] Aborted: ${e.message}`);
    }
  })();

  const t4Promise = (async () => {
    try {
      console.log(`[T4] Attempting to acquire X lock on A (waits for T3)...`);
      await db.lockManager.acquireRowLock(t4.txnId, ridA, LockMode.X);
      console.log(`[T4] Acquired X lock on A!`);
      await db.txnManager.commit(t4.txnId);
    } catch (e: any) {
      console.log(`[T4] Aborted: ${e.message}`);
    }
  })();

  // Wait for deadlock detector to break the cycle
  await Promise.all([t3Promise, t4Promise]);
  console.log(`[Main] Deadlock resolved!`);

  } finally {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
