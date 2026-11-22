import type { Schema } from '../common/types.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';
import type { PhysicalNode } from './PhysicalPlan.js';
import { columnRef } from './Predicates.js';

/** One table's columns inside a row flowing between operators. */
interface LayoutEntry {
  ref: string;
  schema: Schema;
}

/**
 * The binder numbers columns within their own table, but a join emits
 * `[...leftRow, ...rightRow]` in whatever order the join orderer chose. This
 * pass rewrites every column reference to its offset in the row the operator
 * actually receives. Expressions are copied, never mutated, so the logical
 * plan stays reusable; local indexes are recomputed from column names, so
 * running it twice is harmless.
 */
export function resolveColumns(root: PhysicalNode): PhysicalNode {
  return resolve(root).node;
}

function resolve(node: PhysicalNode): { node: PhysicalNode; layout: LayoutEntry[] } {
  switch (node.kind) {
    case 'phys_seq_scan':
    case 'phys_index_scan':
      return { node, layout: [{ ref: node.alias ?? (node.tableId as string), schema: node.schema }] };
    case 'phys_filter': {
      const child = resolve(node.child);
      return { node: { ...node, child: child.node, predicate: rewrite(node.predicate, child.layout) }, layout: child.layout };
    }
    case 'phys_delete': {
      const child = resolve(node.child);
      return { node: { ...node, child: child.node }, layout: child.layout };
    }
    case 'phys_nlj':
    case 'phys_hash_join': {
      const left = resolve(node.left);
      const right = resolve(node.right);
      const layout = [...left.layout, ...right.layout];
      return {
        node: { ...node, left: left.node, right: right.node, condition: rewrite(node.condition, layout) },
        layout,
      };
    }
    case 'phys_project': {
      const child = resolve(node.child);
      return { node: { ...node, child: child.node, projections: node.projections.map(p => rewrite(p, child.layout)) }, layout: [] };
    }
    case 'phys_insert':
      return { node, layout: [] };
  }
}

function rewrite(expr: BoundExpression, layout: LayoutEntry[]): BoundExpression {
  switch (expr.kind) {
    case 'bound_col': {
      const ref = columnRef(expr);
      let offset = 0;
      for (const entry of layout) {
        if (entry.ref === ref) {
          const local = entry.schema.findIndex(c => c.name === expr.columnName);
          if (local === -1) break;
          return { ...expr, columnIndex: offset + local };
        }
        offset += entry.schema.length;
      }
      throw new Error(`Column ${ref}.${expr.columnName} is not available at this point in the plan`);
    }
    case 'bound_literal':
      return { ...expr };
    case 'bound_binary':
    case 'bound_logical':
      return { ...expr, left: rewrite(expr.left, layout), right: rewrite(expr.right, layout) };
  }
}
