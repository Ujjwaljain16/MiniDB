// src/concurrency/LockManager.ts — Phase 5

import type { ILockManager, LockMode } from '../common/interfaces.js';
import type { TxnId, TableId, RID } from '../common/types.js';

export class LockManager implements ILockManager {
  acquireTableLock(_txnId: TxnId, _tableId: TableId, _mode: LockMode): Promise<void> { throw new Error('NYI — Phase 5'); }
  acquireRowLock(_txnId: TxnId, _rid: RID, _mode: LockMode): Promise<void> { throw new Error('NYI — Phase 5'); }
  releaseAll(_txnId: TxnId): void { throw new Error('NYI — Phase 5'); }
  buildWaitForGraph(): Map<TxnId, TxnId[]> { throw new Error('NYI — Phase 5'); }
}
