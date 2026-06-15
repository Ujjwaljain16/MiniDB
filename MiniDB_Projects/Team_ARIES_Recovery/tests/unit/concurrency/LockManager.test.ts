import { LockManager } from '../../../src/concurrency/LockManager';
import { LockMode } from '../../../src/common/interfaces';
import type { TxnId, RID } from '../../../src/common/types';

describe('LockManager', () => {
  let lm: LockManager;
  const rid1: RID = { pageId: 1 as any, slotId: 1 as any };
  const rid2: RID = { pageId: 1 as any, slotId: 2 as any };

  beforeEach(() => {
    lm = new LockManager();
  });

  describe('Matrix Integrity & Simple Grants', () => {
    it('S and S are compatible', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      await lm.acquireRowLock(2 as TxnId, rid1, LockMode.S);
      // If it returns immediately, test passes
      expect(true).toBe(true);
    });

    it('X blocks S', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.X);
      
      let sAcquired = false;
      const sPromise = lm.acquireRowLock(2 as TxnId, rid1, LockMode.S).then(() => {
        sAcquired = true;
      });

      // Wait a tick to let event loop run
      await new Promise(r => setTimeout(r, 10));
      expect(sAcquired).toBe(false);

      lm.releaseAll(1 as TxnId);
      await sPromise;
      expect(sAcquired).toBe(true);
    });

    it('S blocks X', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      
      let xAcquired = false;
      const xPromise = lm.acquireRowLock(2 as TxnId, rid1, LockMode.X).then(() => {
        xAcquired = true;
      });

      await new Promise(r => setTimeout(r, 10));
      expect(xAcquired).toBe(false);

      lm.releaseAll(1 as TxnId);
      await xPromise;
      expect(xAcquired).toBe(true);
    });

    it('X blocks X', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.X);
      
      let xAcquired = false;
      const xPromise = lm.acquireRowLock(2 as TxnId, rid1, LockMode.X).then(() => {
        xAcquired = true;
      });

      await new Promise(r => setTimeout(r, 10));
      expect(xAcquired).toBe(false);

      lm.releaseAll(1 as TxnId);
      await xPromise;
      expect(xAcquired).toBe(true);
    });
  });

  describe('Starvation Prevention & Upgrades', () => {
    it('enforces FIFO fairness (T1:S, T2:X(wait), T3:S(wait))', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      
      let t2Acquired = false;
      let t3Acquired = false;
      
      const p2 = lm.acquireRowLock(2 as TxnId, rid1, LockMode.X).then(() => { t2Acquired = true; });
      
      // Delay slightly to ensure T2 is queued before T3
      await new Promise(r => setTimeout(r, 5));
      const p3 = lm.acquireRowLock(3 as TxnId, rid1, LockMode.S).then(() => { t3Acquired = true; });

      await new Promise(r => setTimeout(r, 10));
      expect(t2Acquired).toBe(false);
      expect(t3Acquired).toBe(false); // T3 must wait because T2 is ahead in queue

      // Release T1
      lm.releaseAll(1 as TxnId);
      await p2;
      expect(t2Acquired).toBe(true);
      expect(t3Acquired).toBe(false); // T3 still waits for T2(X)

      // Release T2
      lm.releaseAll(2 as TxnId);
      await p3;
      expect(t3Acquired).toBe(true);
    });

    it('handles S -> X upgrade correctly', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      
      let upgraded = false;
      // Upgrade should succeed immediately because T1 is the only lock holder
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.X).then(() => { upgraded = true; });
      expect(upgraded).toBe(true);
    });

    it('upgrade waits if other S locks exist, then resolves when they release', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      await lm.acquireRowLock(2 as TxnId, rid1, LockMode.S);
      
      let upgraded = false;
      const p = lm.acquireRowLock(1 as TxnId, rid1, LockMode.X).then(() => { upgraded = true; });
      
      await new Promise(r => setTimeout(r, 10));
      expect(upgraded).toBe(false); // Waiting for T2 to release S

      lm.releaseAll(2 as TxnId);
      await p;
      expect(upgraded).toBe(true);
    });

    it('rejects concurrent upgrades to prevent deadlock', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.S);
      await lm.acquireRowLock(2 as TxnId, rid1, LockMode.S);
      
      // T1 requests upgrade (waits)
      const p1 = lm.acquireRowLock(1 as TxnId, rid1, LockMode.X);
      
      // T2 requests upgrade -> should throw deadlock error
      await expect(lm.acquireRowLock(2 as TxnId, rid1, LockMode.X)).rejects.toThrow(/Deadlock avoided/);
    });
  });

  describe('Deadlock Graph Construction', () => {
    it('builds WFG correctly', async () => {
      await lm.acquireRowLock(1 as TxnId, rid1, LockMode.X);
      
      // T2 and T3 wait on T1
      lm.acquireRowLock(2 as TxnId, rid1, LockMode.S);
      lm.acquireRowLock(3 as TxnId, rid1, LockMode.X);

      await new Promise(r => setTimeout(r, 10));
      
      const graph = lm.buildWaitForGraph();
      // T2 is waiting for T1
      expect(graph.get(2 as TxnId)).toContain(1 as TxnId);
      // T3 is waiting for T1 (since T1 holds the granted lock). 
      // Note: in a strict wait-for graph, T3 might also wait for T2, but waiting on the granted is sufficient for cycles involving holders.
      expect(graph.get(3 as TxnId)).toContain(1 as TxnId);
    });
  });
});
