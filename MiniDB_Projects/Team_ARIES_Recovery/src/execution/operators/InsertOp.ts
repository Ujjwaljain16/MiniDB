import { Operator } from '../Operator.js';
import type { PhysInsert } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { LockMode } from '../../common/interfaces.js';
import { evaluate } from '../Evaluator.js';

export class InsertOp extends Operator {
  private executed = false;

  constructor(private plan: PhysInsert) {
    super();
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
  }

  async next(): Promise<TupleSlot | null> {
    if (this.executed) return null;
    this.executed = true;

    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    if (!tableInfo) throw new Error(`Table ${this.plan.tableId} not found`);

    let affectedRows = 0;

    for (const rowExprs of this.plan.values) {
      // Evaluate the row expressions
      const tuple = rowExprs.map(expr => evaluate(expr, [], []));

      // insertTuple now handles the WAL appending safely while the page is pinned
      const rid = await tableInfo.heapFile.insertTuple(tuple, tableInfo.schema, this.ctx);

      // Acquire X lock on the newly created row
      // (Phantom protection is limited as we do not take IX table locks)
      await this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, rid, LockMode.X);

      // Update B+ tree indexes if any exist
      for (const [idxName, idxInfo] of Object.entries(tableInfo.indexes)) {
        const colIdx = tableInfo.schema.findIndex(c => c.name === idxInfo.column);
        if (colIdx !== -1) {
          const key = tuple[colIdx];
          await idxInfo.tree.insert(key, rid);
        }
      }

      affectedRows++;
    }

    return { tuple: [affectedRows] };
  }

  async close(): Promise<void> {}
}
