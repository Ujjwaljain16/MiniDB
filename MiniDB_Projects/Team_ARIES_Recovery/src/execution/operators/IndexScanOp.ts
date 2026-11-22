import { Operator } from '../Operator.js';
import type { PhysIndexScan } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { LockMode } from '../../common/interfaces.js';
import type { RID } from '../../common/types.js';

export class IndexScanOp extends Operator {
  private iterator: AsyncIterableIterator<RID> | undefined;

  constructor(private plan: PhysIndexScan) {
    super();
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    if (!tableInfo) {
      throw new Error(`IndexScanOp: Table not found ${this.plan.tableId}`);
    }

    const indexInfo = tableInfo.indexes[this.plan.indexId];
    if (!indexInfo) {
      throw new Error(`IndexScanOp: Index not found ${String(this.plan.indexId)}`);
    }

    this.iterator = indexInfo.tree.searchRange(this.plan.lowKey, this.plan.highKey);
  }

  async next(): Promise<TupleSlot | null> {
    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    while (true) {
      const result = await this.iterator!.next();
      if (result.done) {
        return null;
      }

      const rid = result.value;

      // Acquire Shared Lock on the RID
      await this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, rid, LockMode.S);

      // Fetch the tuple from the heap file
      const tuple = await tableInfo!.heapFile.getTuple(rid, tableInfo!.schema);

      // A stale RID (row deleted after the index entry was read) is skipped.
      if (tuple) {
        return { tuple, rid };
      }
    }
  }

  async close(): Promise<void> {
    await this.iterator?.return?.();
    this.iterator = undefined;
  }
}
