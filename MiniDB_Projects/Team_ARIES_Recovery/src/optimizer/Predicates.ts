import type { ColValue } from '../common/types.js';
import type { BoundExpression, BoundColumnRef } from '../sql/LogicalPlan.js';

/** Name a column's table goes by in the query: its alias, else the table id. */
export function columnRef(col: BoundColumnRef): string {
  return col.tableAlias ?? (col.tableId as string);
}

/** Every table (by alias or id) an expression reads a column from. */
export function tablesReferenced(expr: BoundExpression, out: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'bound_col':
      out.add(columnRef(expr));
      break;
    case 'bound_binary':
    case 'bound_logical':
      tablesReferenced(expr.left, out);
      tablesReferenced(expr.right, out);
      break;
  }
  return out;
}

/** Flatten nested ANDs into their conjuncts. */
export function splitConjuncts(pred: BoundExpression): BoundExpression[] {
  if (pred.kind === 'bound_logical' && pred.op === 'AND') {
    return [...splitConjuncts(pred.left), ...splitConjuncts(pred.right)];
  }
  return [pred];
}

/** AND together a non-empty list of predicates. */
export function andAll(preds: BoundExpression[]): BoundExpression {
  return preds.reduce((acc, p) => ({ kind: 'bound_logical', op: 'AND', left: acc, right: p }));
}

export interface KeyRange {
  low: ColValue | null;
  high: ColValue | null;
}

const FLIPPED: Record<string, string> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

/**
 * Inclusive key range implied by a `col <op> literal` (or `literal <op> col`)
 * comparison on the given column of the given table, or null when an index
 * on that column can't serve the predicate (!=, LIKE, NULL, other columns).
 */
export function indexRange(pred: BoundExpression, column: string, ref: string): KeyRange | null {
  if (pred.kind !== 'bound_binary') return null;
  let col: BoundExpression = pred.left;
  let lit: BoundExpression = pred.right;
  let op: string | undefined = pred.op;
  if (col.kind !== 'bound_col') {
    [col, lit] = [lit, col];
    op = FLIPPED[op];
  }
  if (!op || !(op in FLIPPED)) return null;
  if (col.kind !== 'bound_col' || lit.kind !== 'bound_literal' || lit.value === null) return null;
  if (col.columnName !== column || columnRef(col) !== ref) return null;

  switch (op) {
    case '=': return { low: lit.value, high: lit.value };
    case '>':
    case '>=': return { low: lit.value, high: null };
    default: return { low: null, high: lit.value };
  }
}
