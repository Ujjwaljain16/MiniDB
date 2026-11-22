import type { PhysicalNode } from '../optimizer/PhysicalPlan.js';
import type { ExecContext, IOperator, TupleSlot } from '../common/interfaces.js';
import type { ResultSet, PlanInfo } from '../common/types.js';
import { describeNode, renderPlan, toPlanInfo } from '../optimizer/Explain.js';

import { SeqScanOp } from './operators/SeqScanOp.js';
import { IndexScanOp } from './operators/IndexScanOp.js';
import { FilterOp } from './operators/FilterOp.js';
import { ProjectOp } from './operators/ProjectOp.js';
import { NestedLoopJoinOp } from './operators/NestedLoopJoinOp.js';
import { InsertOp } from './operators/InsertOp.js';
import { DeleteOp } from './operators/DeleteOp.js';
import { LimitOp } from './operators/LimitOp.js';

export interface OperatorStats {
  rowsProduced: number;
  elapsedMs: number;
}

export class TrackedOperator implements IOperator {
  public stats: OperatorStats = { rowsProduced: 0, elapsedMs: 0 };

  constructor(public inner: IOperator, public plan: PhysicalNode, public children: TrackedOperator[] = []) {}

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
    const children: TrackedOperator[] = [];
    const buildChild = (node: PhysicalNode) => {
      const child = this.buildOperatorTree(node);
      children.push(child);
      return child;
    };
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
      case 'phys_limit':
        inner = new LimitOp(plan, buildChild as any);
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

    return new TrackedOperator(inner, plan, children);
  }

  /**
   * Executes a physical query plan and materializes the result into a ResultSet.
   */
  async execute(plan: PhysicalNode, ctx: ExecContext): Promise<ResultSet> {
    const root = this.buildOperatorTree(plan);
    const rows: any[][] = [];

    try {
      await root.open(ctx);
      while (true) {
        const slot = await root.next();
        if (!slot) break;
        rows.push(slot.tuple);
      }
    } finally {
      // Always close so scans stopped early (LIMIT, errors) release their pinned pages.
      await root.close();
    }

    const executedPlan = this.explainAnalyzePlan(root);

    // Determine output columns if possible
    let columns: string[] = [];
    let output = plan;
    while (output.kind === 'phys_limit') output = output.child;
    if (output.kind === 'phys_project') {
      columns = output.projections.map(p => p.alias || 'col');
    } else if (output.kind === 'phys_seq_scan' || output.kind === 'phys_index_scan') {
      columns = output.schema.map(c => c.name);
    } else if (output.kind === 'phys_insert' || output.kind === 'phys_delete') {
      columns = ['affected_rows'];
      const totalAffected = rows.length > 0 ? rows.reduce((acc, r) => acc + r[0], 0) : 0;
      return { columns, rows: [[totalAffected]], rowsAffected: totalAffected, plan: executedPlan };
    } else {
      columns = rows.length > 0 ? rows[0]!.map((_, i) => `col${i}`) : [];
    }

    return { columns, rows, plan: executedPlan };
  }

  /** Text for EXPLAIN: the plan tree with table, index range, predicates and estimates. */
  explainTree(plan: PhysicalNode): string {
    return renderPlan(this.explainPlan(plan));
  }

  /** Text for EXPLAIN ANALYZE: the plan tree with actual rows and time per operator. */
  explainAnalyzeTree(op: TrackedOperator): string {
    return renderPlan(this.explainAnalyzePlan(op));
  }

  /** Structured plan with estimates only, for EXPLAIN. */
  explainPlan(physical: PhysicalNode): PlanInfo {
    return toPlanInfo(physical);
  }

  /** Structured plan of an executed operator tree, with actual rows and time. */
  explainAnalyzePlan(root: TrackedOperator): PlanInfo {
    return {
      kind: root.plan.kind,
      ...describeNode(root.plan),
      estRows: root.plan.estRows,
      estCost: root.plan.estCost,
      actualRows: root.stats.rowsProduced,
      timeMs: root.stats.elapsedMs,
      children: root.children.map(child => this.explainAnalyzePlan(child)),
    };
  }
}
