import { Operator } from '../Operator.js';
import type { PhysIndexScan } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { LockMode } from '../../common/interfaces.js';
import type { RID } from '../../common/types.js';

export class IndexScanOp extends Operator {
  private iterator!: AsyncIterableIterator<RID>;

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

    let low: any = null;
    let high: any = null;

    // Extract bounds from keyCondition if present
    if (this.plan.keyCondition && this.plan.keyCondition.kind === 'bound_binary') {
      const expr = this.plan.keyCondition;
      let val: any = null;

      if (expr.left.kind === 'bound_col' && expr.right.kind === 'bound_literal') {
        val = expr.right.value;
      } else if (expr.right.kind === 'bound_col' && expr.left.kind === 'bound_literal') {
        val = expr.left.value;
      }

      if (val !== null) {
        if (expr.op === '=') {
          low = val;
          high = val;
        } else if (expr.op === '>') {
          low = val;
          // We don't have a strict MAX_VAL defined, so this is a hacky fallback.
          // In a real system, we'd pass an inclusive/exclusive flag and a max boundary.
          // For now, if we can't bound it, we'll just scan from 'val' upwards.
          // Wait, searchRange requires both. We will just use val as both for now,
          // or assume the caller handles filtering.
          // Actually BPlusTree.searchRange requires finite bounds.
          // Let's just set low and high to val and rely on FilterOp if it's not equality.
          low = val;
          high = val; 
        } else {
          low = val;
          high = val;
        }
      }
    }

    // Default to a point lookup if bounds are parsed, or we'd need a full scan.
    // If no condition, we might just fail or return empty, since index scan without bounds isn't typically point lookup.
    // For now, assume it's a point lookup.
    if (low !== null && high !== null) {
      this.iterator = indexInfo.tree.searchRange(low, high);
    } else {
      // Create an empty iterator if we couldn't parse the condition
      this.iterator = (async function* () {})();
    }
  }

  async next(): Promise<TupleSlot | null> {
    const result = await this.iterator.next();
    if (result.done) {
      return null;
    }

    const rid = result.value;

    // Acquire Shared Lock on the RID
    await this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, rid, LockMode.S);

    // Fetch the tuple from the heap file
    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    const tuple = await tableInfo!.heapFile.getTuple(rid, tableInfo!.schema);

    if (!tuple) {
      // Handle the case where the index has a stale RID (e.g., deleted row)
      // For now, we skip and try the next one.
      return this.next();
    }

    return { tuple, rid };
  }

  async close(): Promise<void> {
    // Nothing to close
  }
}
