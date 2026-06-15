// src/concurrency/TxnManager.ts — Phase 5

import type { ITxnManager, Transaction } from '../common/interfaces.js';
import type { TxnId } from '../common/types.js';

export class TxnManager implements ITxnManager {
  begin(): Promise<Transaction> { throw new Error('NYI — Phase 5'); }
  commit(_txnId: TxnId): Promise<void> { throw new Error('NYI — Phase 5'); }
  abort(_txnId: TxnId): Promise<void> { throw new Error('NYI — Phase 5'); }
  getTransaction(_txnId: TxnId): Transaction | undefined { return undefined; }
  activeTransactions(): ReadonlyMap<TxnId, Transaction> { return new Map(); }
}

