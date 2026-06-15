import type { Schema, Tuple } from '../common/types.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';

export function evaluate(expr: BoundExpression, tuple: Tuple, schema: Schema): any {
  switch (expr.kind) {
    case 'bound_literal':
      return expr.value;

    case 'bound_col':
      return tuple[expr.columnIndex];

    case 'bound_binary': {
      const left = evaluate(expr.left, tuple, schema);
      const right = evaluate(expr.right, tuple, schema);

      // Handle nulls
      if (left === null || right === null) {
        return null;
      }

      switch (expr.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '=': return left === right;
        case '!=':
        case '<>': return left !== right;
        case '<': return left < right;
        case '<=': return left <= right;
        case '>': return left > right;
        case '>=': return left >= right;
        default:
          throw new Error(`Unsupported binary operator: ${expr.op}`);
      }
    }

    case 'bound_logical': {
      const left = evaluate(expr.left, tuple, schema);
      const right = evaluate(expr.right, tuple, schema);

      if (expr.op === 'AND') {
        return Boolean(left && right);
      } else if (expr.op === 'OR') {
        return Boolean(left || right);
      }
      throw new Error(`Unsupported logical operator: ${expr.op}`);
    }

    default:
      throw new Error(`Unsupported expression kind: ${(expr as any).kind}`);
  }
}
