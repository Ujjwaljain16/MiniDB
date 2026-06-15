import type { LogicalNode, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalInsert, LogicalDelete, BoundExpression, BoundColumnRef } from '../sql/LogicalPlan.js';
import type { PhysicalNode, PhysSeqScan, PhysIndexScan, PhysFilter, PhysProject, PhysInsert, PhysDelete } from './PhysicalPlan.js';
import type { ICatalog, TableStats, CatalogEntry } from '../common/interfaces.js';
import { seqScanCost, indexScanCost, estimateSelectivity } from './CostModel.js';
import { JoinOrderer, JoinNode } from './JoinOrderer.js';
import type { TableId } from '../common/types.js';

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

  private planScan(node: LogicalScan, pushedPredicate?: BoundExpression): PhysicalNode {
    const entry = this.catalog.getTable(node.tableId);
    let stats: TableStats;
    try {
      stats = entry.stats;
      if (!stats) throw new Error();
    } catch {
      // Fallback statistics
      stats = {
        rowCount: 1000,
        columnStats: {}
      };
    }

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

    // Check if we can use an index based on the pushed predicate
    if (pushedPredicate && pushedPredicate.kind === 'bound_binary') {
      const left = pushedPredicate.left;
      const right = pushedPredicate.right;

      let colName: string | undefined;
      
      if (left.kind === 'bound_col' && right.kind === 'bound_literal') {
        if (!left.tableAlias || left.tableAlias === node.alias || left.tableAlias === node.tableId) {
          colName = left.columnName;
        }
      } else if (right.kind === 'bound_col' && left.kind === 'bound_literal') {
        if (!right.tableAlias || right.tableAlias === node.alias || right.tableAlias === node.tableId) {
          colName = right.columnName;
        }
      }

      if (colName) {
        // Find if an index exists on this column
        for (const [idxName, idxDef] of Object.entries(entry.indexes)) {
          if (idxDef.column === colName) {
            // Index available!
            const selectivity = estimateSelectivity(pushedPredicate, stats);
            const idxCost = indexScanCost(stats.rowCount, selectivity);
            
            if (idxCost < bestCost) {
              bestCost = idxCost;
              bestPlan = {
                kind: 'phys_index_scan',
                tableId: node.tableId,
                indexId: idxName as any,
                schema: node.schema,
                alias: node.alias,
                keyCondition: pushedPredicate,
                estRows: Math.ceil(stats.rowCount * selectivity),
                estCost: idxCost
              } as PhysIndexScan;
            }
          }
        }
      }
    }

    return bestPlan;
  }

  private planFilter(node: LogicalFilter): PhysicalNode {
    if (node.child.kind === 'scan') {
      // Try to push the predicate down into the scan to trigger an index scan
      const scanNode = this.planScan(node.child as LogicalScan, node.predicate);
      
      if (scanNode.kind === 'phys_index_scan') {
        // The index scan inherently filters on this predicate
        // However, if there are other conditions in the predicate (e.g. AND), we might still need a filter.
        // For simplicity, if it became an index scan, we assume the index condition handles it.
        // But what if it's `id = 5 AND age > 20`? 
        // We should just wrap the index scan with the filter anyway. The index scan will return fewer rows.
        // We'll wrap it for safety unless the engine natively drops the evaluated condition.
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
        const entry = this.catalog.getTable(tableId);
        stats = entry.stats;
        if (!stats) throw new Error();
      } catch {
        stats = { rowCount: 1000, columnStats: {} };
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
