import type { ITxnManager, ILockManager, ILogManager, Transaction } from '../common/interfaces.js';
import { TxnState } from '../common/interfaces.js';
import type { TxnId, LSN } from '../common/types.js';
import { INVALID_LSN } from '../common/types.js';

export class TxnManager implements ITxnManager {
  private nextTxnId = 1 as TxnId;
  private active = new Map<TxnId, Transaction>();

  constructor(
    private lockManager: ILockManager,
    private logManager: ILogManager
  ) {}

  async begin(): Promise<Transaction> {
    const txnId = (this.nextTxnId++) as TxnId;
    
    const lsn = await this.logManager.append({
      txnId,
      type: 'BEGIN',
      prevLsn: INVALID_LSN,
    });

    const txn: Transaction = {
      txnId,
      state: TxnState.GROWING,
      beginLsn: lsn,
      prevLsn: lsn,
    };

    this.active.set(txnId, txn);
    return txn;
  }

  async commit(txnId: TxnId): Promise<void> {
    const txn = this.active.get(txnId);
    if (!txn) throw new Error(`Cannot commit: Txn ${txnId} not active`);
    if (txn.state === TxnState.ABORTED) throw new Error(`Cannot commit: Txn ${txnId} already aborted`);

    // 1. Append COMMIT log record
    const lsn = await this.logManager.append({
      txnId,
      type: 'COMMIT',
      prevLsn: txn.prevLsn,
    });

    // 2. Flush WAL to make commit durable
    await this.logManager.flush(lsn);

    // 3. Strict 2PL: Release all locks
    this.lockManager.releaseAll(txnId);

    txn.state = TxnState.COMMITTED;
    txn.prevLsn = lsn;
    this.active.delete(txnId);
  }

  async abort(txnId: TxnId): Promise<void> {
    const txn = this.active.get(txnId);
    if (!txn) return; // Already finished or unknown

    if (txn.state === TxnState.COMMITTED) {
      throw new Error(`Cannot abort: Txn ${txnId} already committed`);
    }

    // Mark as aborted immediately to stop further operations
    txn.state = TxnState.ABORTED;

    // TODO (Phase 6): Undo all changes (walk prevLsn chain, apply beforeImages)
    // For now, in Phase 5, we just write the ABORT record and release locks.
    
    const lsn = await this.logManager.append({
      txnId,
      type: 'ABORT',
      prevLsn: txn.prevLsn,
    });

    // Strict 2PL: Release all locks
    this.lockManager.releaseAll(txnId);

    txn.prevLsn = lsn;
    this.active.delete(txnId);
  }

  getTransaction(txnId: TxnId): Transaction | undefined {
    return this.active.get(txnId);
  }

  activeTransactions(): ReadonlyMap<TxnId, Transaction> {
    return this.active;
  }
}
