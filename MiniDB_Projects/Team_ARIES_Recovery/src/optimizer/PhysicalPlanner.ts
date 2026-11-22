import type { LogicalNode, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalLimit, LogicalInsert, LogicalDelete, BoundExpression, BoundColumnRef } from '../sql/LogicalPlan.js';
import type { PhysicalNode, PhysSeqScan, PhysIndexScan, PhysFilter, PhysProject, PhysLimit, PhysInsert, PhysDelete } from './PhysicalPlan.js';
import type { ICatalog, TableStats, CatalogEntry } from '../common/interfaces.js';
import { seqScanCost, indexScanCost, estimateSelectivity } from './CostModel.js';
import { JoinOrderer, JoinNode } from './JoinOrderer.js';
import { indexRange, andAll, splitConjuncts, tablesReferenced } from './Predicates.js';
import { resolveColumns } from './ColumnResolver.js';
import { compareKeys } from '../index/BPlusKeyUtils.js';
import type { TableId, IndexId, ColValue } from '../common/types.js';

const FALLBACK_ROW_COUNT = 1000;

/**
 * A table that was never analyzed has `{rowCount: 0, columnStats: {}}`; costing
 * it as empty makes every seq scan free, so assume a modest size instead.
 */
function effectiveStats(stats: TableStats | undefined): TableStats {
  if (!stats || (stats.rowCount === 0 && Object.keys(stats.columnStats ?? {}).length === 0)) {
    return { rowCount: FALLBACK_ROW_COUNT, columnStats: {} };
  }
  return stats;
}

export class PhysicalPlanner {
  constructor(private catalog: ICatalog) {}

  plan(node: LogicalNode): PhysicalNode {
    return resolveColumns(this.planNode(node));
  }

  private planNode(node: LogicalNode): PhysicalNode {
    switch (node.kind) {
      case 'scan':
        return this.planScan(node);
      case 'filter':
        return this.planFilter(node);
      case 'project':
        return this.planProject(node);
      case 'limit':
        return this.planLimit(node);
      case 'join':
        return this.planJoinTree(node, []);
      case 'insert':
        return this.planInsert(node);
      case 'delete':
        return this.planDelete(node);
      default:
        throw new Error(`Unsupported logical node kind`);
    }
  }

  /**
   * Picks a seq scan or an index scan for `node`. `conjuncts` are AND-ed
   * predicates on this table; the index scan uses those on its key column to
   * bound the range, but the caller must still filter on all of them.
   */
  private planScan(node: LogicalScan, conjuncts: BoundExpression[] = []): PhysicalNode {
    const entry = this.catalog.getTable(node.tableId);
    const stats = effectiveStats(entry.stats);

    const seqCost = seqScanCost(stats.rowCount);
    let bestCost = seqCost;
    let bestPlan: PhysicalNode = {
      kind: 'phys_seq_scan',
      tableId: node.tableId,
      schema: node.schema,
      alias: node.alias,
      estRows: stats.rowCount,
      estCost: seqCost
    } as PhysSeqScan;

    const ref = node.alias ?? (node.tableId as string);
    for (const [idxName, idxDef] of Object.entries(entry.indexes)) {
      const colDef = entry.schema.find(c => c.name === idxDef.column);
      if (!colDef) continue;

      const keyConds: BoundExpression[] = [];
      let low: ColValue | null = null;
      let high: ColValue | null = null;
      for (const conj of conjuncts) {
        const range = indexRange(conj, idxDef.column, ref);
        if (!range) continue;
        keyConds.push(conj);
        if (range.low !== null && (low === null || compareKeys(range.low, low, colDef) > 0)) low = range.low;
        if (range.high !== null && (high === null || compareKeys(range.high, high, colDef) < 0)) high = range.high;
      }
      if (keyConds.length === 0) continue;

      const keyCondition = andAll(keyConds);
      const selectivity = estimateSelectivity(keyCondition, stats);
      const idxCost = indexScanCost(stats.rowCount, selectivity);
      if (idxCost < bestCost) {
        bestCost = idxCost;
        bestPlan = {
          kind: 'phys_index_scan',
          tableId: node.tableId,
          indexId: idxName as IndexId,
          schema: node.schema,
          alias: node.alias,
          keyColumn: idxDef.column,
          keyCondition,
          lowKey: low,
          highKey: high,
          estRows: Math.ceil(stats.rowCount * selectivity),
          estCost: idxCost
        } as PhysIndexScan;
      }
    }

    return bestPlan;
  }

  private planFilter(node: LogicalFilter): PhysicalNode {
    if (node.child.kind === 'scan') {
      // The index range is only a superset of the matches, so the full predicate stays on top.
      return this.planFilteredScan(node.child, splitConjuncts(node.predicate), node.predicate);
    }

    if (node.child.kind === 'join') {
      // Inner joins make WHERE and ON interchangeable, so the join planner places every conjunct.
      return this.planJoinTree(node.child, splitConjuncts(node.predicate));
    }

    const childPlan = this.planNode(node.child);
    const tableId = this.extractTableId(node.child);

    let stats: TableStats | undefined;
    if (tableId) {
      try {
        stats = effectiveStats(this.catalog.getTable(tableId).stats);
      } catch {
        stats = effectiveStats(undefined);
      }
    }

    const sel = estimateSelectivity(node.predicate, stats);
    return this.makeFilter(childPlan, node.predicate, Math.ceil(childPlan.estRows * sel));
  }

  /** Access path for a table plus a filter on `predicate` (the AND of `conjuncts`). */
  private planFilteredScan(scan: LogicalScan, conjuncts: BoundExpression[], predicate?: BoundExpression): PhysicalNode {
    const access = this.planScan(scan, conjuncts);
    if (conjuncts.length === 0) return access;
    const stats = effectiveStats(this.catalog.getTable(scan.tableId).stats);
    const fullPredicate = predicate ?? andAll(conjuncts);
    const estRows = Math.min(access.estRows, Math.ceil(stats.rowCount * estimateSelectivity(fullPredicate, stats)));
    return this.makeFilter(access, fullPredicate, estRows);
  }

  private makeFilter(child: PhysicalNode, predicate: BoundExpression, estRows: number): PhysFilter {
    return {
      kind: 'phys_filter',
      child,
      predicate,
      estRows,
      estCost: child.estCost + child.estRows * 0.1 // small CPU cost for filtering
    };
  }

  private planLimit(node: LogicalLimit): PhysicalNode {
    const childPlan = this.planNode(node.child);
    return {
      kind: 'phys_limit',
      child: childPlan,
      limit: node.limit,
      estRows: Math.min(childPlan.estRows, node.limit),
      estCost: childPlan.estCost
    } as PhysLimit;
  }

  private planProject(node: LogicalProject): PhysicalNode {
    const childPlan = this.planNode(node.child);
    return {
      kind: 'phys_project',
      child: childPlan,
      projections: node.projections,
      estRows: childPlan.estRows,
      estCost: childPlan.estCost + childPlan.estRows * 0.05 // small CPU cost
    } as PhysProject;
  }

  /**
   * Plans a tree of inner joins. All ON conditions and `extraConjuncts` (from a
   * WHERE directly above) are split into conjuncts: single-table ones are pushed
   * into that table's scan, multi-table ones go to the join where their tables
   * meet, and table-free ones (e.g. `1 = 0`) stay in a filter on top.
   */
  private planJoinTree(node: LogicalNode, extraConjuncts: BoundExpression[]): PhysicalNode {
    const leaves: LogicalScan[] = [];
    const conjuncts: BoundExpression[] = [...extraConjuncts];

    const collect = (n: LogicalNode) => {
      if (n.kind === 'join') {
        collect(n.left);
        collect(n.right);
        conjuncts.push(...splitConjuncts((n as LogicalJoin).condition));
      } else if (n.kind === 'scan') {
        leaves.push(n);
      } else {
        throw new Error(`Unsupported join input: ${n.kind}`);
      }
    };
    collect(node);

    const pushed = new Map<string, BoundExpression[]>();
    const joinConditions: BoundExpression[] = [];
    const topConditions: BoundExpression[] = [];
    for (const conj of conjuncts) {
      const refs = tablesReferenced(conj);
      if (refs.size === 0) {
        topConditions.push(conj);
      } else if (refs.size === 1) {
        const ref = [...refs][0]!;
        pushed.set(ref, [...(pushed.get(ref) ?? []), conj]);
      } else {
        joinConditions.push(conj);
      }
    }

    const scans: JoinNode[] = leaves.map(leaf => {
      const ref = leaf.alias ?? (leaf.tableId as string);
      const physNode = this.planFilteredScan(leaf, pushed.get(ref) ?? []);
      return { node: physNode, tables: new Set([ref]), estRows: physNode.estRows };
    });

    const orderer = new JoinOrderer(this.catalog);
    const joined = orderer.orderJoins(scans, joinConditions);
    return topConditions.length > 0 ? this.makeFilter(joined, andAll(topConditions), joined.estRows) : joined;
  }

  private planInsert(node: LogicalInsert): PhysicalNode {
    return {
      kind: 'phys_insert',
      tableId: node.tableId,
      columns: node.columns,
      values: node.values,
      estRows: node.values.length,
      estCost: node.values.length * 1.2 // PAGE_WRITE_COST
    } as PhysInsert;
  }

  private planDelete(node: LogicalDelete): PhysicalNode {
    const childPlan = this.planNode(node.child);
    return {
      kind: 'phys_delete',
      tableId: node.tableId,
      child: childPlan,
      estRows: childPlan.estRows,
      estCost: childPlan.estCost + childPlan.estRows * 1.2 // read then write
    } as PhysDelete;
  }

  private extractTableId(node: LogicalNode): TableId | undefined {
    if (node.kind === 'scan') return (node as LogicalScan).tableId;
    if (node.kind === 'filter') return this.extractTableId((node as LogicalFilter).child);
    if (node.kind === 'project') return this.extractTableId((node as LogicalProject).child);
    return undefined;
  }
}
