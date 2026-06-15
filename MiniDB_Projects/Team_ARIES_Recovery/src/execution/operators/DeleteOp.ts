import { Operator } from '../Operator.js';
import type { PhysDelete } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { LockMode } from '../../common/interfaces.js';

export class DeleteOp extends Operator {
  private child!: Operator;
  private executed = false;

  constructor(private plan: PhysDelete, private buildChild: (node: any) => Operator) {
    super();
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    await this.child.open(ctx);
  }

  async next(): Promise<TupleSlot | null> {
    if (this.executed) return null;
    this.executed = true;

    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    if (!tableInfo) throw new Error(`Table ${this.plan.tableId} not found`);

    let affectedRows = 0;

    while (true) {
      const slot = await this.child.next();
      if (!slot) break;

      if (!slot.rid) {
        throw new Error('DeleteOp received a TupleSlot without an RID. Ensure projections preserve RIDs.');
      }

      // Acquire X lock on the row before deleting
      await this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, slot.rid, LockMode.X);

      // deleteTuple now handles the WAL appending safely
      await tableInfo.heapFile.deleteTuple(slot.rid, this.ctx);

      // Update B+ tree indexes if any exist
      for (const [idxName, idxInfo] of Object.entries(tableInfo.indexes)) {
        const colIdx = tableInfo.schema.findIndex(c => c.name === idxInfo.column);
        if (colIdx !== -1) {
          const key = slot.tuple[colIdx];
          await idxInfo.tree.delete(key, slot.rid);
        }
      }

      affectedRows++;
    }

    return { tuple: [affectedRows] };
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}
