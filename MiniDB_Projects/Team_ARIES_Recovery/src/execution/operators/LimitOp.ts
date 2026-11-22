import { Operator } from '../Operator.js';
import type { PhysLimit } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';

export class LimitOp extends Operator {
  private child!: Operator;
  private emitted = 0;

  constructor(private plan: PhysLimit, private buildChild: (node: any) => Operator) {
    super();
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    this.emitted = 0;
    await this.child.open(ctx);
  }

  async next(): Promise<TupleSlot | null> {
    if (this.emitted >= this.plan.limit) return null;
    const slot = await this.child.next();
    if (slot) this.emitted++;
    return slot;
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}
