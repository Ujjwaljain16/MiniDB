import { Operator } from '../Operator.js';
import type { PhysSeqScan } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { LockMode } from '../../common/interfaces.js';
import type { RID, Tuple } from '../../common/types.js';

export class SeqScanOp extends Operator {
  private iterator!: AsyncIterableIterator<[RID, Tuple]>;

  constructor(private plan: PhysSeqScan) {
    super();
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    if (!tableInfo) {
      throw new Error(`SeqScanOp: Table not found ${this.plan.tableId}`);
    }
    
    // We scan using the schema required by the query plan
    this.iterator = tableInfo.heapFile.scan(this.plan.schema);
  }

  async next(): Promise<TupleSlot | null> {
    const result = await this.iterator.next();
    if (result.done) {
      return null;
    }

    const [rid, tuple] = result.value;

    // Strict 2PL: Acquire Shared Lock for read visibility
    await this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, rid, LockMode.S);

    return { tuple, rid };
  }

  async close(): Promise<void> {
    // Async iterators from generator functions don't usually need explicit close,
    // but if we added early return/break logic to the generator, we could handle it here.
  }
}
