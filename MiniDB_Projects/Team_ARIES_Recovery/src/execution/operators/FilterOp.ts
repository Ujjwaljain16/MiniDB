import { Operator } from '../Operator.js';
import type { PhysFilter } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { evaluate } from '../Evaluator.js';

export class FilterOp extends Operator {
  private child!: Operator;

  constructor(private plan: PhysFilter, private buildChild: (node: any) => Operator) {
    super();
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    await this.child.open(ctx);
  }

  async next(): Promise<TupleSlot | null> {
    while (true) {
      const slot = await this.child.next();
      if (!slot) {
        return null;
      }

      // Evaluate the predicate against the tuple
      // We pass the schema of the child operator. The child's schema is currently embedded in the query plan
      // Wait, evaluate needs a Schema to know column types, but BoundColumnRef actually stores everything we need
      // (like columnIndex) so we don't strictly need the schema. We'll pass an empty schema for now or extract from plan if needed.
      // Wait, evaluate function's signature is evaluate(expr, tuple, schema)
      const isMatch = evaluate(this.plan.predicate, slot.tuple, []);

      if (isMatch) {
        return slot; // return the matching TupleSlot, preserving its RID
      }
    }
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}
