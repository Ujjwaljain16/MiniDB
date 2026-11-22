import type { PhysicalNode, PhysIndexScan } from './PhysicalPlan.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';
import type { ColValue, PlanInfo } from '../common/types.js';

const LABELS: Record<PhysicalNode['kind'], string> = {
  phys_seq_scan: 'Seq Scan',
  phys_index_scan: 'Index Scan',
  phys_filter: 'Filter',
  phys_project: 'Project',
  phys_limit: 'Limit',
  phys_nlj: 'Nested Loop Join',
  phys_hash_join: 'Hash Join',
  phys_insert: 'Insert',
  phys_delete: 'Delete',
};

export function planChildren(node: PhysicalNode): PhysicalNode[] {
  switch (node.kind) {
    case 'phys_project':
    case 'phys_filter':
    case 'phys_limit':
    case 'phys_delete':
      return [node.child];
    case 'phys_nlj':
    case 'phys_hash_join':
      return [node.left, node.right];
    default:
      return [];
  }
}

export function describeNode(node: PhysicalNode): { label: string; detail: string } {
  let detail = '';
  switch (node.kind) {
    case 'phys_seq_scan':
      detail = tableName(node.tableId, node.alias);
      break;
    case 'phys_index_scan':
      detail = `${tableName(node.tableId, node.alias)} using ${String(node.indexId)}: ${formatRange(node)}`;
      break;
    case 'phys_project':
      detail = node.projections.map(p => formatExpr(p)).join(', ');
      break;
    case 'phys_filter':
      detail = formatExpr(node.predicate);
      break;
    case 'phys_limit':
      detail = String(node.limit);
      break;
    case 'phys_nlj':
    case 'phys_hash_join':
      detail = isTrueLiteral(node.condition) ? 'cross join' : formatExpr(node.condition);
      break;
    case 'phys_insert':
      detail = `INTO ${node.tableId} (${node.values.length} row${node.values.length === 1 ? '' : 's'})`;
      break;
    case 'phys_delete':
      detail = `FROM ${node.tableId}`;
      break;
  }
  return { label: LABELS[node.kind], detail };
}

/** Structured plan with estimates only. */
export function toPlanInfo(node: PhysicalNode): PlanInfo {
  return {
    kind: node.kind,
    ...describeNode(node),
    estRows: node.estRows,
    estCost: node.estCost,
    children: planChildren(node).map(toPlanInfo),
  };
}

/** Text tree for EXPLAIN / EXPLAIN ANALYZE; actuals are shown when present. */
export function renderPlan(info: PlanInfo, prefix: string = '', isLeft: boolean = true, isRoot: boolean = true): string {
  let result = isRoot ? '=== Query Plan ===\n' : '';

  // Formatting tree branches
  const branch = isRoot ? '' : (isLeft ? '├── ' : '└── ');
  const nextPrefix = isRoot ? '' : prefix + (isLeft ? '│   ' : '    ');

  const costStr = `cost=${info.estCost.toFixed(0)}, rows=~${info.estRows}`;
  const actualStr = info.actualRows !== undefined
    ? ` (actual rows=${info.actualRows}, time=${(info.timeMs ?? 0).toFixed(3)} ms)`
    : '';
  result += `${prefix}${branch}${info.kind} [${info.detail}] ${costStr}${actualStr}\n`;

  info.children.forEach((child, i) => {
    result += renderPlan(child, nextPrefix, i < info.children.length - 1, false);
  });
  return result;
}

export function explainTree(node: PhysicalNode): string {
  return renderPlan(toPlanInfo(node));
}

export function formatExpr(expr: BoundExpression): string {
  switch (expr.kind) {
    case 'bound_col':
      return expr.tableAlias ? `${expr.tableAlias}.${expr.columnName}` : expr.columnName;
    case 'bound_literal':
      return formatValue(expr.value);
    case 'bound_binary':
      return `${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)}`;
    case 'bound_logical':
      return `(${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)})`;
    default:
      return '?';
  }
}

function tableName(tableId: string, alias: string | undefined): string {
  return alias && alias !== tableId ? `${tableId} AS ${alias}` : tableId;
}

function formatValue(value: ColValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
}

function formatRange(node: PhysIndexScan): string {
  const col = node.keyColumn;
  const { lowKey: low, highKey: high } = node;
  if (low !== null && high !== null) {
    return low === high ? `${col} = ${formatValue(low)}` : `${formatValue(low)} <= ${col} <= ${formatValue(high)}`;
  }
  if (low !== null) return `${col} >= ${formatValue(low)}`;
  if (high !== null) return `${col} <= ${formatValue(high)}`;
  return 'full index';
}

function isTrueLiteral(expr: BoundExpression): boolean {
  return expr.kind === 'bound_literal' && expr.value === true;
}
