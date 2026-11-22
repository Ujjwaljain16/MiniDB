import type { LogicalNode, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalInsert, LogicalDelete, BoundExpression, BoundColumnRef } from '../sql/LogicalPlan.js';
import type { PhysicalNode, PhysSeqScan, PhysIndexScan, PhysFilter, PhysProject, PhysInsert, PhysDelete } from './PhysicalPlan.js';
import type { ICatalog, TableStats, CatalogEntry } from '../common/interfaces.js';
import { seqScanCost, indexScanCost, estimateSelectivity } from './CostModel.js';
import { JoinOrderer, JoinNode } from './JoinOrderer.js';
import { indexRange, andAll, splitConjuncts } from './Predicates.js';
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
    switch (node.kind) {
      case 'scan':
        return this.planScan(node, undefined);
      case 'filter':
        return this.planFilter(node);
      case 'project':
        return this.planProject(node);
      case 'join':
        return this.planJoinTree(node);
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
      // Try to push the predicate down into the scan to trigger an index scan
      const scanNode = this.planScan(node.child as LogicalScan, splitConjuncts(node.predicate));

      if (scanNode.kind === 'phys_index_scan') {
        // The index range is only a superset of the matches, so the full predicate stays on top.
        const estRows = scanNode.estRows; // filter further reduces it, but let's keep it simple
        const estCost = scanNode.estCost;
        return {
          kind: 'phys_filter',
          child: scanNode,
          predicate: node.predicate,
          estRows,
          estCost
        } as PhysFilter;
      }
    }

    const childPlan = this.plan(node.child);
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
    const estRows = Math.ceil(childPlan.estRows * sel);
    const estCost = childPlan.estCost + childPlan.estRows * 0.1; // small CPU cost for filtering

    return {
      kind: 'phys_filter',
      child: childPlan,
      predicate: node.predicate,
      estRows,
      estCost
    } as PhysFilter;
  }

  private planProject(node: LogicalProject): PhysicalNode {
    const childPlan = this.plan(node.child);
    return {
      kind: 'phys_project',
      child: childPlan,
      projections: node.projections,
      estRows: childPlan.estRows,
      estCost: childPlan.estCost + childPlan.estRows * 0.05 // small CPU cost
    } as PhysProject;
  }

  private planJoinTree(node: LogicalNode): PhysicalNode {
    // Collect all joined relations and conditions
    const scans: JoinNode[] = [];
    const conditions: BoundExpression[] = [];

    const collect = (n: LogicalNode) => {
      if (n.kind === 'join') {
        collect(n.left);
        collect(n.right);
        conditions.push((n as LogicalJoin).condition);
      } else if (n.kind === 'scan') {
        const physScan = this.planScan(n as LogicalScan);
        const refName = (n as LogicalScan).alias || (n as LogicalScan).tableId as string;
        scans.push({
          node: physScan,
          tables: new Set([refName]),
          estRows: physScan.estRows
        });
      } else {
        // If it's a subquery or filtered scan before join
        const physNode = this.plan(n);
        // We'll just assign a generic table name for the set
        scans.push({
          node: physNode,
          tables: new Set(['__subquery__']),
          estRows: physNode.estRows
        });
      }
    };

    collect(node);

    const orderer = new JoinOrderer(this.catalog);
    return orderer.orderJoins(scans, conditions);
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
    const childPlan = this.plan(node.child);
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
