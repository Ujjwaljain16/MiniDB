import { LockManager } from '../../../src/concurrency/LockManager';
import { TxnManager } from '../../../src/concurrency/TxnManager';
import { DeadlockDetector } from '../../../src/concurrency/DeadlockDetector';
import { NullLogManager } from '../../../src/recovery/LogManager';
import { LockMode, TxnState } from '../../../src/common/interfaces';
import type { TxnId, RID } from '../../../src/common/types';

describe('DeadlockDetector', () => {
  let lm: LockManager;
  let txnManager: TxnManager;
  let detector: DeadlockDetector;
  let logManager: NullLogManager;
  
  const ridA: RID = { pageId: 1 as any, slotId: 1 as any };
  const ridB: RID = { pageId: 2 as any, slotId: 1 as any };
  const ridC: RID = { pageId: 3 as any, slotId: 1 as any };

  beforeEach(() => {
    lm = new LockManager();
    logManager = new NullLogManager();
    txnManager = new TxnManager(lm, logManager);
    detector = new DeadlockDetector(lm, txnManager, 50); // fast interval for tests
  });

  afterEach(() => {
    detector.stop();
  });

  it('detects a 2-txn deadlock and aborts the youngest', async () => {
    const t1 = await txnManager.begin(); // TxnId = 1
    const t2 = await txnManager.begin(); // TxnId = 2

    // T1 acquires X(A)
    await lm.acquireRowLock(t1.txnId, ridA, LockMode.X);
    // T2 acquires X(B)
    await lm.acquireRowLock(t2.txnId, ridB, LockMode.X);

    // T1 waits for X(B)
    const p1 = lm.acquireRowLock(t1.txnId, ridB, LockMode.X);
    
    // Slight delay to ensure deterministic queueing
    await new Promise(r => setTimeout(r, 10));

    // T2 waits for X(A) => Deadlock!
    const p2 = lm.acquireRowLock(t2.txnId, ridA, LockMode.X);

    // Wait for the detector to run
    detector.detect(); // run manually for determinism

    // T2 (TxnId=2) is the youngest, it should be aborted.
    // That means p2 should reject.
    await expect(p2).rejects.toThrow('aborted while waiting');
    
    // T2's state should be aborted
    expect(t2.state).toBe(TxnState.ABORTED);

    // Because T2 is aborted, it releases X(B).
    // So p1 should now resolve!
    await p1;
    expect(t1.state).toBe(TxnState.GROWING);
  });

  it('detects a 3-txn deadlock and aborts the youngest', async () => {
    const t1 = await txnManager.begin(); // 1
    const t2 = await txnManager.begin(); // 2
    const t3 = await txnManager.begin(); // 3

    await lm.acquireRowLock(t1.txnId, ridA, LockMode.X);
    await lm.acquireRowLock(t2.txnId, ridB, LockMode.X);
    await lm.acquireRowLock(t3.txnId, ridC, LockMode.X);

    // T1 waits for B
    const p1 = lm.acquireRowLock(t1.txnId, ridB, LockMode.X);
    await new Promise(r => setTimeout(r, 5));
    
    // T2 waits for C
    const p2 = lm.acquireRowLock(t2.txnId, ridC, LockMode.X);
    await new Promise(r => setTimeout(r, 5));

    // T3 waits for A => Cycle! (1->2->3->1)
    const p3 = lm.acquireRowLock(t3.txnId, ridA, LockMode.X);

    detector.detect();

    // T3 is the youngest, should be aborted.
    await expect(p3).rejects.toThrow('aborted');
    expect(t3.state).toBe(TxnState.ABORTED);

    // T3 aborts -> releases C -> p2 resolves
    await p2;
    expect(t2.state).toBe(TxnState.GROWING);
    
    // But p1 is still waiting for B (held by T2)
    // Let's release T2's locks
    txnManager.abort(t2.txnId); // or commit
    await p1;
    expect(t1.state).toBe(TxnState.GROWING);
  });
});
