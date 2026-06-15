import type { TableId, Schema } from '../common/types.js';

export type LogicalNode =
  | LogicalScan
  | LogicalFilter
  | LogicalProject
  | LogicalJoin
  | LogicalInsert
  | LogicalDelete;

export interface LogicalScan {
  kind: 'scan';
  tableId: TableId;
  schema: Schema;
  alias?: string;
}

export interface LogicalFilter {
  kind: 'filter';
  child: LogicalNode;
  predicate: BoundExpression;
}

export interface LogicalProject {
  kind: 'project';
  child: LogicalNode;
  projections: BoundExpression[];
}

export interface LogicalJoin {
  kind: 'join';
  left: LogicalNode;
  right: LogicalNode;
  condition: BoundExpression;
  joinType: 'inner';
}

export interface LogicalInsert {
  kind: 'insert';
  tableId: TableId;
  columns: string[];
  values: BoundExpression[][];
}

export interface LogicalDelete {
  kind: 'delete';
  tableId: TableId;
  child: LogicalNode;
}

// Expressions
export type BoundExpression = 
  | BoundColumnRef
  | BoundLiteral
  | BoundBinaryExpr
  | BoundLogicalExpr;

export interface BoundColumnRef {
  kind: 'bound_col';
  tableId: TableId;
  tableAlias?: string;
  columnName: string;
  columnIndex: number;
  type: string;
  alias?: string; // AS alias in projection
}

export interface BoundLiteral {
  kind: 'bound_literal';
  value: number | string | boolean | null;
  type: string;
  alias?: string;
}

export interface BoundBinaryExpr {
  kind: 'bound_binary';
  op: string;
  left: BoundExpression;
  right: BoundExpression;
  alias?: string;
}

export interface BoundLogicalExpr {
  kind: 'bound_logical';
  op: 'AND' | 'OR';
  left: BoundExpression;
  right: BoundExpression;
  alias?: string;
}

// Pretty Printer
export function prettyPrint(plan: LogicalNode, indent: number = 0): string {
  const pad = ' '.repeat(indent);
  switch (plan.kind) {
    case 'scan':
      return `${pad}LogicalScan\n${pad}  table: ${plan.tableId}${plan.alias ? ' as ' + plan.alias : ''}`;
    case 'filter':
      return `${pad}LogicalFilter\n${pad}  condition: ${prettyExpr(plan.predicate)}\n${prettyPrint(plan.child, indent + 4)}`;
    case 'project':
      const cols = plan.projections.map(prettyExpr).join(', ');
      return `${pad}LogicalProject\n${pad}  columns: [${cols}]\n${prettyPrint(plan.child, indent + 4)}`;
    case 'join':
      return `${pad}LogicalJoin (${plan.joinType})\n${pad}  condition: ${prettyExpr(plan.condition)}\n${prettyPrint(plan.left, indent + 4)}\n${prettyPrint(plan.right, indent + 4)}`;
    case 'insert':
      return `${pad}LogicalInsert\n${pad}  table: ${plan.tableId}\n${pad}  columns: [${plan.columns.join(', ')}]`;
    case 'delete':
      return `${pad}LogicalDelete\n${pad}  table: ${plan.tableId}\n${prettyPrint(plan.child, indent + 4)}`;
  }
}

function prettyExpr(expr: BoundExpression): string {
  switch (expr.kind) {
    case 'bound_col':
      const colStr = expr.tableAlias ? `${expr.tableAlias}.${expr.columnName}` : `${expr.tableId}.${expr.columnName}`;
      return expr.alias ? `${colStr} as ${expr.alias}` : colStr;
    case 'bound_literal':
      const valStr = typeof expr.value === 'string' ? `'${expr.value}'` : String(expr.value);
      return expr.alias ? `${valStr} as ${expr.alias}` : valStr;
    case 'bound_binary':
      const binStr = `${prettyExpr(expr.left)} ${expr.op} ${prettyExpr(expr.right)}`;
      return expr.alias ? `(${binStr}) as ${expr.alias}` : `(${binStr})`;
    case 'bound_logical':
      return `(${prettyExpr(expr.left)} ${expr.op} ${prettyExpr(expr.right)})`;
  }
}
