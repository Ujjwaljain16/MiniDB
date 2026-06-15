import type { TableStats, ColumnStats } from '../common/interfaces.js';
import type { BoundBinaryExpr, BoundExpression, BoundColumnRef, BoundLiteral } from '../sql/LogicalPlan.js';

export const PAGE_READ_COST = 1.0;
export const ROWS_PER_PAGE = 100;

export function seqScanCost(rowCount: number): number {
  return Math.ceil(rowCount / ROWS_PER_PAGE) * PAGE_READ_COST;
}

export function indexScanCost(rowCount: number, selectivity: number): number {
  const btreeHeight = 3; // at demo scale, typically 3 levels
  return (btreeHeight * PAGE_READ_COST) + (selectivity * rowCount * PAGE_READ_COST);
}

export function estimateSelectivity(pred: BoundExpression, tableStats: TableStats | undefined): number {
  const DEFAULT_SELECTIVITY = 0.1;
  
  if (!tableStats || !tableStats.columnStats) {
    return DEFAULT_SELECTIVITY;
  }

  if (pred.kind === 'bound_logical') {
    const leftSel = estimateSelectivity(pred.left, tableStats);
    const rightSel = estimateSelectivity(pred.right, tableStats);
    if (pred.op === 'AND') {
      return leftSel * rightSel;
    } else { // OR
      return leftSel + rightSel - (leftSel * rightSel);
    }
  }

  if (pred.kind !== 'bound_binary') {
    return DEFAULT_SELECTIVITY;
  }

  // Expect col <op> literal for simple estimation
  let colNode: BoundColumnRef | undefined;
  let litNode: BoundLiteral | undefined;
  let op = pred.op;

  if (pred.left.kind === 'bound_col' && pred.right.kind === 'bound_literal') {
    colNode = pred.left as BoundColumnRef;
    litNode = pred.right as BoundLiteral;
  } else if (pred.right.kind === 'bound_col' && pred.left.kind === 'bound_literal') {
    colNode = pred.right as BoundColumnRef;
    litNode = pred.left as BoundLiteral;
    // Swap operator direction
    if (op === '<') op = '>';
    else if (op === '<=') op = '>=';
    else if (op === '>') op = '<';
    else if (op === '>=') op = '<=';
  } else {
    // Both columns or complex expressions
    return DEFAULT_SELECTIVITY;
  }

  const stats = tableStats.columnStats[colNode.columnName];
  if (!stats) return DEFAULT_SELECTIVITY;

  switch (op) {
    case '=':
      return stats.nDistinct > 0 ? 1 / stats.nDistinct : DEFAULT_SELECTIVITY;
    case '!=':
      return stats.nDistinct > 0 ? 1 - (1 / stats.nDistinct) : 0.9;
    case '<':
    case '<=': {
      const min = Number(stats.min);
      const max = Number(stats.max);
      const val = Number(litNode.value);
      if (isNaN(min) || isNaN(max) || isNaN(val)) return DEFAULT_SELECTIVITY;
      if (val <= min) return 0.01;
      if (val >= max) return 1.0;
      return (val - min) / (max - min);
    }
    case '>':
    case '>=': {
      const min = Number(stats.min);
      const max = Number(stats.max);
      const val = Number(litNode.value);
      if (isNaN(min) || isNaN(max) || isNaN(val)) return DEFAULT_SELECTIVITY;
      if (val >= max) return 0.01;
      if (val <= min) return 1.0;
      return (max - val) / (max - min);
    }
    case 'LIKE':
      // Heuristic selectivity estimation for string predicates due to the absence of string histograms.
      return 0.1; 
    default:
      return DEFAULT_SELECTIVITY;
  }
}
