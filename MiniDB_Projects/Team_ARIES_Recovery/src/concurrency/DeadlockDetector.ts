import type { ILockManager, ITxnManager } from '../common/interfaces.js';
import type { TxnId } from '../common/types.js';

export class DeadlockDetector {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private lockManager: ILockManager,
    private txnManager: ITxnManager,
    private intervalMs: number = 100
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.detect(), this.intervalMs);
    // don't block node process exit
    if (this.intervalId.unref) this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      delete this.intervalId;
    }
  }

  detect(): void {
    const graph = this.lockManager.buildWaitForGraph();
    const cycle = this.dfsFindCycle(graph);
    
    if (cycle && cycle.length > 0) {
      // Victim Selection: Abort youngest txn in cycle (highest TxnId)
      let victim = cycle[0]!;
      for (let i = 1; i < cycle.length; i++) {
        if (cycle[i]! > victim) {
          victim = cycle[i]!;
        }
      }
      
      console.warn(`[DEADLOCK] Cycle detected: ${cycle.join(' -> ')}. Aborting TxnId=${victim}`);
      
      // Abort victim asynchronously (don't block detector)
      this.txnManager.abort(victim).catch(err => {
        console.error(`[DEADLOCK] Failed to abort victim ${victim}:`, err);
      });
    }
  }

  private dfsFindCycle(graph: Map<TxnId, TxnId[]>): TxnId[] | null {
    // 0 = WHITE (unseen)
    // 1 = GRAY  (visiting)
    // 2 = BLACK (done)
    const color = new Map<TxnId, 0 | 1 | 2>();

    for (const node of graph.keys()) {
      if (color.get(node) !== 2) { // Not BLACK
        const path: TxnId[] = [];
        const result = this.dfs(node, graph, color, path);
        if (result) return result;
      }
    }
    return null;
  }

  private dfs(node: TxnId, graph: Map<TxnId, TxnId[]>, color: Map<TxnId, 0 | 1 | 2>, path: TxnId[]): TxnId[] | null {
    color.set(node, 1); // GRAY
    path.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      const neighborColor = color.get(neighbor) || 0;
      
      if (neighborColor === 1) { // GRAY - Cycle!
        // We found a cycle. Return just the cycle part of the path.
        const cycleStartIndex = path.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          return path.slice(cycleStartIndex);
        }
        return path; // Fallback
      }
      
      if (neighborColor === 0) { // WHITE
        const result = this.dfs(neighbor, graph, color, path);
        if (result) return result;
      }
    }

    color.set(node, 2); // BLACK
    path.pop();
    return null;
  }
}
