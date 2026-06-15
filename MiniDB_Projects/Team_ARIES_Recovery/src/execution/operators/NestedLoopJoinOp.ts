import { Operator } from '../Operator.js';
import type { PhysNLJ } from '../../optimizer/PhysicalPlan.js';
import type { ExecContext, TupleSlot } from '../../common/interfaces.js';
import { evaluate } from '../Evaluator.js';

export class NestedLoopJoinOp extends Operator {
  private left!: Operator;
  private right!: Operator;
  
  private leftSlot: TupleSlot | null = null;
  private isRightOpen: boolean = false;

  constructor(private plan: PhysNLJ, private buildChild: (node: any) => Operator) {
    super();
    this.left = this.buildChild(plan.left);
    this.right = this.buildChild(plan.right);
  }

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    await this.left.open(ctx);
    // We don't open right here; we open it per outer tuple
  }

  async next(): Promise<TupleSlot | null> {
    while (true) {
      if (!this.leftSlot) {
        this.leftSlot = await this.left.next();
        if (!this.leftSlot) {
          return null; // Exhausted outer child
        }
        
        // Reset and open inner child for the new outer tuple
        if (this.isRightOpen) {
          await this.right.close();
        }
        await this.right.open(this.ctx);
        this.isRightOpen = true;
      }

      const rightSlot = await this.right.next();
      if (!rightSlot) {
        // Exhausted inner child, move to next outer tuple
        this.leftSlot = null;
        continue;
      }

      // Concatenate tuples to form the joined tuple for evaluation
      const joinedTuple = [...this.leftSlot.tuple, ...rightSlot.tuple];

      // Evaluate join condition
      const isMatch = evaluate(this.plan.condition, joinedTuple, []);

      if (isMatch) {
        // Return joined tuple. Joined tuples typically don't have a single RID.
        return { tuple: joinedTuple };
      }
    }
  }

  async close(): Promise<void> {
    await this.left.close();
    if (this.isRightOpen) {
      await this.right.close();
    }
  }
}
