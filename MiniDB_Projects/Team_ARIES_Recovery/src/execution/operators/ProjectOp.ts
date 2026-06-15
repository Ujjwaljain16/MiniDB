import { Operator } from '../Operator.js';
import type { PhysProject } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { evaluate } from '../Evaluator.js';

export class ProjectOp extends Operator {
  private child!: Operator;

  constructor(private plan: PhysProject, private buildChild: (node: any) => Operator) {
    super();
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    await this.child.open(ctx);
  }

  async next(): Promise<TupleSlot | null> {
    const slot = await this.child.next();
    if (!slot) {
      return null;
    }

    const projectedTuple = this.plan.projections.map(expr => 
      evaluate(expr, slot.tuple, [])
    );

    const result: TupleSlot = { tuple: projectedTuple };
    if (slot.rid !== undefined) {
      result.rid = slot.rid;
    }
    return result;
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}
