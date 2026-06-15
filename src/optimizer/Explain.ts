import type { PhysicalNode } from './PhysicalPlan.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';

export function explainTree(node: PhysicalNode, prefix: string = '', isLeft: boolean = true, isRoot: boolean = true): string {
  let result = '';
  
  if (isRoot) {
    result += '=== Query Plan ===\n';
  }

  // Formatting tree branches
  const branch = isRoot ? '' : (isLeft ? '├── ' : '└── ');
  const nextPrefix = isRoot ? '' : prefix + (isLeft ? '│   ' : '    ');

  // Node description
  let desc = node.kind;
  let details = '';

  switch (node.kind) {
    case 'phys_seq_scan':
      details = `[${node.tableId}${node.alias ? ' as ' + node.alias : ''}]`;
      break;
    case 'phys_index_scan':
      details = `[${node.tableId}.${node.indexId}]`;
      break;
    case 'phys_project':
      details = `[${node.projections.map(p => formatExpr(p)).join(', ')}]`;
      break;
    case 'phys_filter':
      details = `[${formatExpr(node.predicate)}]`;
      break;
    case 'phys_nlj':
    case 'phys_hash_join':
      details = `[${formatExpr(node.condition)}]`;
      break;
    case 'phys_insert':
      details = `[INTO ${node.tableId}]`;
      break;
    case 'phys_delete':
      details = `[FROM ${node.tableId}]`;
      break;
  }

  const costStr = `cost=${node.estCost.toFixed(0)}, rows=~${node.estRows}`;
  result += `${prefix}${branch}${desc} ${details} ${costStr}\n`;

  // Children
  switch (node.kind) {
    case 'phys_project':
    case 'phys_filter':
    case 'phys_delete':
      result += explainTree(node.child, nextPrefix, false, false);
      break;
    case 'phys_nlj':
    case 'phys_hash_join':
      result += explainTree(node.left, nextPrefix, true, false);
      result += explainTree(node.right, nextPrefix, false, false);
      break;
  }

  return result;
}

function formatExpr(expr: BoundExpression): string {
  switch (expr.kind) {
    case 'bound_col':
      return expr.tableAlias ? `${expr.tableAlias}.${expr.columnName}` : expr.columnName;
    case 'bound_literal':
      return typeof expr.value === 'string' ? `'${expr.value}'` : String(expr.value);
    case 'bound_binary':
      return `${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)}`;
    case 'bound_logical':
      return `(${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)})`;
    default:
      return '?';
  }
}
