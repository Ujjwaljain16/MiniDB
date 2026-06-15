import type { ILockManager } from '../common/interfaces.js';
import { LockMode, LOCK_COMPAT } from '../common/interfaces.js';
import type { TxnId, RID } from '../common/types.js';

export interface LockRequest {
  txnId: TxnId;
  mode: LockMode;
  granted: boolean;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

export interface LockQueue {
  granted: LockRequest[];
  waiting: LockRequest[];
}

function ridKey(rid: RID): string {
  return `${rid.pageId}:${rid.slotId}`;
}

export class LockManager implements ILockManager {
  private lockTable = new Map<string, LockQueue>();

  async acquireRowLock(txnId: TxnId, rid: RID, mode: LockMode): Promise<void> {
    const key = ridKey(rid);
    const queue = this.getOrCreate(key);

    // Check if transaction already holds a lock on this RID
    const existingIndex = queue.granted.findIndex(r => r.txnId === txnId);
    if (existingIndex !== -1) {
      const existing = queue.granted[existingIndex]!;
      if (existing.mode === mode) {
        return; // Already holds the exact lock
      }
      if (existing.mode === LockMode.X && mode === LockMode.S) {
        return; // X lock subsumes S lock
      }
      if (existing.mode === LockMode.S && mode === LockMode.X) {
        // Upgrade request!
        // Rule: Only one upgrading transaction per queue. If there's another upgrade in waiting, we should fail to prevent deadlock.
        const alreadyUpgrading = queue.waiting.some(r => r.txnId !== txnId && r.mode === LockMode.X && queue.granted.some(g => g.txnId === r.txnId));
        if (alreadyUpgrading) {
          throw new Error(`Deadlock avoided: Multiple concurrent upgrades on RID ${key}`);
        }

        // If we are the only one holding S lock, grant immediately
        if (queue.granted.length === 1) {
          existing.mode = LockMode.X;
          return;
        }

        // Otherwise, wait for other S locks to release
        return new Promise((resolve, reject) => {
          // Put the upgrade request at the FRONT of the wait queue to prioritize it
          queue.waiting.unshift({ txnId, mode, granted: false, resolve, reject });
        });
      }
    }

    // Check if we can grant immediately
    // We can grant if:
    // 1. Waiting queue is empty (FIFO fairness)
    // 2. The requested mode is compatible with ALL currently granted modes
    const isCompatible = queue.granted.every(r => LOCK_COMPAT[r.mode]![mode]);
    
    if (queue.waiting.length === 0 && isCompatible) {
      queue.granted.push({ txnId, mode, granted: true });
      return;
    }

    // Otherwise, enqueue and wait
    return new Promise((resolve, reject) => {
      queue.waiting.push({ txnId, mode, granted: false, resolve, reject });
    });
  }

  releaseAll(txnId: TxnId): void {
    // Remove all granted and waiting locks for this txnId across all queues
    for (const [key, queue] of this.lockTable.entries()) {
      const initialGrantedLength = queue.granted.length;
      
      // Remove from granted
      queue.granted = queue.granted.filter(r => r.txnId !== txnId);
      
      // Remove from waiting (e.g., if aborted while waiting)
      const waitingReqs = queue.waiting.filter(r => r.txnId === txnId);
      queue.waiting = queue.waiting.filter(r => r.txnId !== txnId);
      
      for (const req of waitingReqs) {
        if (req.reject) req.reject(new Error(`Transaction ${txnId} aborted while waiting for lock`));
      }

      if (queue.granted.length < initialGrantedLength || waitingReqs.length > 0) {
        this.grantWaiters(queue);
      }

      // Cleanup empty queues
      if (queue.granted.length === 0 && queue.waiting.length === 0) {
        this.lockTable.delete(key);
      }
    }
  }

  private grantWaiters(queue: LockQueue): void {
    // Attempt to promote waiting transactions to granted
    // Must respect FIFO order.
    while (queue.waiting.length > 0) {
      const first = queue.waiting[0]!;
      
      // Check if it's an upgrade from S -> X
      const isUpgrade = queue.granted.some(r => r.txnId === first.txnId && r.mode === LockMode.S);
      
      let canGrant = false;

      if (isUpgrade) {
        // If it's an upgrade, we can grant it if there are NO OTHER transactions holding a lock.
        // That means the only granted lock must be our own S lock.
        if (queue.granted.length === 1) {
          canGrant = true;
          // Upgrade the existing lock
          const existing = queue.granted[0]!;
          existing.mode = LockMode.X;
        }
      } else {
        canGrant = queue.granted.every(r => LOCK_COMPAT[r.mode]![first.mode]);
      }

      if (canGrant) {
        queue.waiting.shift(); // remove from waiting
        
        if (!isUpgrade) {
          first.granted = true;
          queue.granted.push(first);
        }

        if (first.resolve) first.resolve();
      } else {
        // Stop processing the queue at the first blocked transaction to enforce FIFO fairness
        break;
      }
    }
  }

  buildWaitForGraph(): Map<TxnId, TxnId[]> {
    const graph = new Map<TxnId, TxnId[]>();

    for (const queue of this.lockTable.values()) {
      if (queue.waiting.length > 0 && queue.granted.length > 0) {
        const grantedTxns = queue.granted.map(r => r.txnId);
        
        // Every waiting txn is waiting for ALL currently granted txns that hold incompatible locks
        // Actually, just waiting on the granted txns is sufficient for the basic graph
        for (const w of queue.waiting) {
          if (!graph.has(w.txnId)) graph.set(w.txnId, []);
          
          for (const g of grantedTxns) {
            if (g !== w.txnId) { // don't wait for self (except in upgrade, but upgrade waits for *other* S locks)
              graph.get(w.txnId)!.push(g);
            }
          }
        }
      }
    }

    // Deduplicate arrays
    for (const [txn, waits] of graph.entries()) {
      graph.set(txn, Array.from(new Set(waits)));
    }

    return graph;
  }

  private getOrCreate(key: string): LockQueue {
    let queue = this.lockTable.get(key);
    if (!queue) {
      queue = { granted: [], waiting: [] };
      this.lockTable.set(key, queue);
    }
    return queue;
  }
}
