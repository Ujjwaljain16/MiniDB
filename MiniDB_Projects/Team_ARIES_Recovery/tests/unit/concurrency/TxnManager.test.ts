import { TxnManager } from '../../../src/concurrency/TxnManager';
import { LockManager } from '../../../src/concurrency/LockManager';
import { NullLogManager } from '../../../src/recovery/LogManager';
import { TxnState, LockMode } from '../../../src/common/interfaces';
import type { TxnId, RID } from '../../../src/common/types';

describe('TxnManager', () => {
  let lm: LockManager;
  let logManager: NullLogManager;
  let txnManager: TxnManager;

  const rid1: RID = { pageId: 1 as any, slotId: 1 as any };

  beforeEach(() => {
    lm = new LockManager();
    logManager = new NullLogManager();
    txnManager = new TxnManager(lm, logManager);
  });

  it('begins a transaction in GROWING state', async () => {
    const txn = await txnManager.begin();
    expect(txn.state).toBe(TxnState.GROWING);
    expect(txn.txnId).toBeGreaterThan(0);
    expect(txnManager.getTransaction(txn.txnId)).toBe(txn);
    expect(txnManager.activeTransactions().has(txn.txnId)).toBe(true);
  });

  it('commit releases all locks and moves to COMMITTED state', async () => {
    const txn = await txnManager.begin();
    await lm.acquireRowLock(txn.txnId, rid1, LockMode.X);
    
    // T2 should block
    let t2Acquired = false;
    const p2 = lm.acquireRowLock(2 as TxnId, rid1, LockMode.S).then(() => { t2Acquired = true; });
    
    await new Promise(r => setTimeout(r, 5));
    expect(t2Acquired).toBe(false);

    await txnManager.commit(txn.txnId);
    
    expect(txn.state).toBe(TxnState.COMMITTED);
    expect(txnManager.getTransaction(txn.txnId)).toBeUndefined();
    
    // T2 should now unblock
    await p2;
    expect(t2Acquired).toBe(true);
  });

  it('abort releases all locks and moves to ABORTED state', async () => {
    const txn = await txnManager.begin();
    await lm.acquireRowLock(txn.txnId, rid1, LockMode.X);
    
    let t2Acquired = false;
    const p2 = lm.acquireRowLock(2 as TxnId, rid1, LockMode.S).then(() => { t2Acquired = true; });

    await new Promise(r => setTimeout(r, 5));
    expect(t2Acquired).toBe(false);

    await txnManager.abort(txn.txnId);
    
    expect(txn.state).toBe(TxnState.ABORTED);
    expect(txnManager.getTransaction(txn.txnId)).toBeUndefined();

    // T2 should unblock
    await p2;
    expect(t2Acquired).toBe(true);
  });
});
