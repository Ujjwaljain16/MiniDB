import type { PhysicalNode } from '../optimizer/PhysicalPlan.js';
import type { ExecContext, IOperator, TupleSlot } from '../common/interfaces.js';
import type { ResultSet } from '../common/types.js';

import { SeqScanOp } from './operators/SeqScanOp.js';
import { IndexScanOp } from './operators/IndexScanOp.js';
import { FilterOp } from './operators/FilterOp.js';
import { ProjectOp } from './operators/ProjectOp.js';
import { NestedLoopJoinOp } from './operators/NestedLoopJoinOp.js';
import { InsertOp } from './operators/InsertOp.js';
import { DeleteOp } from './operators/DeleteOp.js';

export interface OperatorStats {
  rowsProduced: number;
  elapsedMs: number;
}

export class TrackedOperator implements IOperator {
  public stats: OperatorStats = { rowsProduced: 0, elapsedMs: 0 };

  constructor(public inner: IOperator, public plan: PhysicalNode) {}

  async open(ctx: ExecContext): Promise<void> {
    const s = performance.now();
    await this.inner.open(ctx);
    this.stats.elapsedMs += (performance.now() - s);
  }

  async next(): Promise<TupleSlot | null> {
    const s = performance.now();
    const slot = await this.inner.next();
    this.stats.elapsedMs += (performance.now() - s);
    if (slot) {
      this.stats.rowsProduced++;
    }
    return slot;
  }

  async close(): Promise<void> {
    const s = performance.now();
    await this.inner.close();
    this.stats.elapsedMs += (performance.now() - s);
  }
}

export class Executor {
  /**
   * Recursively builds the Volcano operator tree from a physical plan,
   * wrapped in TrackedOperators for metrics.
   */
  buildOperatorTree(plan: PhysicalNode): TrackedOperator {
    const buildChild = (node: PhysicalNode) => this.buildOperatorTree(node);
    let inner: IOperator;

    switch (plan.kind) {
      case 'phys_seq_scan':
        inner = new SeqScanOp(plan);
        break;
      case 'phys_index_scan':
        inner = new IndexScanOp(plan);
        break;
      case 'phys_filter':
        inner = new FilterOp(plan, buildChild as any);
        break;
      case 'phys_project':
        inner = new ProjectOp(plan, buildChild as any);
        break;
      case 'phys_nlj':
        inner = new NestedLoopJoinOp(plan, buildChild as any);
        break;
      case 'phys_hash_join':
        throw new Error('Hash Join not implemented in this version.');
      case 'phys_insert':
        inner = new InsertOp(plan);
        break;
      case 'phys_delete':
        inner = new DeleteOp(plan, buildChild as any);
        break;
      default:
        throw new Error(`Unsupported physical node kind: ${(plan as any).kind}`);
    }

    return new TrackedOperator(inner, plan);
  }

  /**
   * Executes a physical query plan and materializes the result into a ResultSet.
   */
  async execute(plan: PhysicalNode, ctx: ExecContext): Promise<ResultSet> {
    const root = this.buildOperatorTree(plan);
    const rows: any[][] = [];

    await root.open(ctx);

    while (true) {
      const slot = await root.next();
      if (!slot) break;
      rows.push(slot.tuple);
    }

    await root.close();

    // Determine output columns if possible
    let columns: string[] = [];
    if (plan.kind === 'phys_project') {
      columns = plan.projections.map(p => p.alias || 'col');
    } else if (plan.kind === 'phys_seq_scan' || plan.kind === 'phys_index_scan') {
      columns = plan.schema.map(c => c.name);
    } else if (plan.kind === 'phys_insert' || plan.kind === 'phys_delete') {
      columns = ['affected_rows'];
      const totalAffected = rows.length > 0 ? rows.reduce((acc, r) => acc + r[0], 0) : 0;
      return { columns, rows: [[totalAffected]], rowsAffected: totalAffected };
    } else {
      columns = rows.length > 0 ? rows[0]!.map((_, i) => `col${i}`) : [];
    }

    return { columns, rows };
  }

  /**
   * Generates a string representation of the EXPLAIN tree.
   */
  explainTree(plan: PhysicalNode, indent: number = 0): string {
    const pad = '  '.repeat(indent);
    let line = `${pad}${plan.kind} (cost=${plan.estCost?.toFixed(2) || 0}, estRows=~${plan.estRows || 0})`;

    if (plan.kind === 'phys_filter') {
      line += `\n${this.explainTree((plan as any).child, indent + 1)}`;
    } else if (plan.kind === 'phys_project') {
      line += `\n${this.explainTree((plan as any).child, indent + 1)}`;
    } else if (plan.kind === 'phys_nlj') {
      line += `\n${this.explainTree((plan as any).outer, indent + 1)}\n${this.explainTree((plan as any).inner, indent + 1)}`;
    }

    return line;
  }

  /**
   * Generates a string representation of the EXPLAIN ANALYZE tree with actual stats.
   */
  explainAnalyzeTree(op: TrackedOperator, indent: number = 0): string {
    const pad = '  '.repeat(indent);
    let line = `${pad}${op.plan.kind} (cost=${op.plan.estCost?.toFixed(2) || 0}, estRows=~${op.plan.estRows || 0})`;
    line += `\n${pad}  [Actual rows: ${op.stats.rowsProduced}, Time: ${op.stats.elapsedMs.toFixed(3)} ms]`;
    
    if (op.inner instanceof FilterOp || op.inner instanceof ProjectOp || op.inner instanceof DeleteOp) {
      const child = (op.inner as any).child as TrackedOperator;
      if (child instanceof TrackedOperator) {
        line += `\n${this.explainAnalyzeTree(child, indent + 1)}`;
      }
    } else if (op.inner instanceof NestedLoopJoinOp) {
      const outer = (op.inner as any).outer as TrackedOperator;
      const innerChild = (op.inner as any).inner as TrackedOperator;
      if (outer instanceof TrackedOperator) line += `\n${this.explainAnalyzeTree(outer, indent + 1)}`;
      if (innerChild instanceof TrackedOperator) line += `\n${this.explainAnalyzeTree(innerChild, indent + 1)}`;
    }

    return line;
  }
}
