import { parse } from 'sql-parser-cst';
import type { 
  Statement, SelectStmt, InsertStmt, DeleteStmt, CreateTableStmt, CreateIndexStmt, DropTableStmt,
  BeginStmt, CommitStmt, AbortStmt, ExplainStmt, AnalyzeStmt, ShowStmt,
  Expression, Projection, TableRef, JoinClause, ColumnDefAST, Literal, BinaryExpr
} from './AST.js';

export interface CstNode {
  type: string;
  name?: string | CstNode;
  text?: string;
  expr?: CstNode;
  items?: CstNode[];
  clauses?: CstNode[];
  columns?: CstNode;
  tables?: CstNode;
  whereKw?: CstNode;
  operator?: string;
  left?: CstNode;
  right?: CstNode;
  value?: unknown;
  object?: CstNode;
  property?: CstNode;
  alias?: CstNode;
  specification?: CstNode;
  table?: CstNode;
  values?: CstNode;
  dataType?: CstNode;
  constraints?: CstNode[];
  params?: CstNode;
  nameKw?: CstNode;
  explainKw?: CstNode;
  queryPlanKw?: CstNode;
  stmt?: CstNode;
  count?: CstNode;
  offset?: CstNode;
  modifiers?: CstNode[];
}

export function parseSQL(sql: string): Statement {
  // We use the sqlite dialect
  let cst;
  try {
    cst = parse(sql, { dialect: 'sqlite' });
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error(`Parse error: ${err.message}`);
    }
    throw new Error('Parse error: unknown');
  }

  if (cst.type !== 'program' || cst.statements.length === 0) {
    throw new Error('No SQL statements found');
  }

  if (cst.statements.length > 1) {
    throw new Error('Only single statements are supported');
  }

  return transformStatement(cst.statements[0] as CstNode);
}

function transformStatement(stmt: CstNode): Statement {
  switch (stmt.type) {
    case 'select_stmt': return transformSelect(stmt);
    case 'insert_stmt': return transformInsert(stmt);
    case 'delete_stmt': return transformDelete(stmt);
    case 'create_table_stmt': return transformCreateTable(stmt);
    case 'create_index_stmt': return transformCreateIndex(stmt);
    case 'drop_table_stmt': return transformDropTable(stmt);
    case 'begin_stmt': return { kind: 'begin' };
    case 'commit_stmt': return { kind: 'commit' };
    case 'rollback_stmt': return { kind: 'abort' };
    case 'explain_stmt': return transformExplain(stmt);
    case 'analyze_stmt': return transformAnalyze(stmt);
    case 'update_stmt':
      throw new Error('UPDATE is not supported; use DELETE then INSERT');
    case 'compound_select_stmt':
      throw new Error(`${operatorName(stmt.operator)} is not supported`);
    // Show is not native to sqlite CST, they might parse as arbitrary or we can intercept them
    default:
      // Try custom parsing for SHOW if sql-parser-cst doesn't support them well
      throw new Error(`Unsupported statement type: ${stmt.type}`);
  }
}

// Transform SELECT
function transformSelect(stmt: CstNode): SelectStmt {
  let selectClause = stmt.clauses?.find((c: CstNode) => c.type === 'select_clause');
  let fromClause = stmt.clauses?.find((c: CstNode) => c.type === 'from_clause');
  let whereClause = stmt.clauses?.find((c: CstNode) => c.type === 'where_clause');
  let limitClause = stmt.clauses?.find((c: CstNode) => c.type === 'limit_clause');

  for (const clause of stmt.clauses ?? []) {
    if (!SELECT_CLAUSES.has(clause.type)) throw new Error(`${clauseLabel(clause.type)} is not supported`);
  }

  if (!selectClause || !fromClause) {
    throw new Error('SELECT must have SELECT and FROM clauses');
  }

  for (const modifier of selectClause.modifiers ?? []) {
    if (modifier.type === 'select_distinct') throw new Error('DISTINCT is not supported');
    if (modifier.type !== 'select_all') throw new Error(`SELECT modifier ${modifier.type} is not supported`);
  }

  const projections = selectClause.columns!.items!.map(transformProjection);

  // From clause handles the primary table and joins
  let primaryTableNode = fromClause.expr!;
  if (primaryTableNode.type === 'list_expr') {
    throw new Error('Comma joins (FROM a, b) are not supported; use JOIN ... ON');
  }
  let joins: JoinClause[] = [];

  if (primaryTableNode.type === 'join_expr') {
    // Unroll join_expr
    let current = primaryTableNode;
    let joinStack: CstNode[] = [];
    while (current.type === 'join_expr') {
      joinStack.push(current);
      current = current.left!;
    }

    primaryTableNode = current;

    // Process joins in order
    while (joinStack.length > 0) {
      const joinNode = joinStack.pop()!;
      const joinOp = operatorName(joinNode.operator);
      if (joinOp === ',') {
        throw new Error('Comma joins (FROM a, b) are not supported; use JOIN ... ON');
      }
      if (joinOp !== 'JOIN' && joinOp !== 'INNER JOIN') {
        throw new Error(`${joinOp} is not supported; only INNER JOIN ... ON is supported`);
      }
      const right = transformTableRef(joinNode.right!);

      let onExpr: Expression;
      if (joinNode.specification && joinNode.specification.type === 'join_on_specification') {
        onExpr = transformExpr(joinNode.specification.expr!);
      } else if (joinNode.specification) {
        throw new Error('JOIN ... USING is not supported; use JOIN ... ON');
      } else {
        throw new Error('JOIN must have an ON condition');
      }

      const joinClause: JoinClause = {
        table: right.table,
        on: onExpr
      };
      if (right.alias) joinClause.alias = right.alias;
      joins.push(joinClause);
    }
  }

  const tableRef = transformTableRef(primaryTableNode);

  const where = whereClause ? transformExpr(whereClause.expr!) : undefined;
  const limit = limitClause ? transformLimit(limitClause) : undefined;

  const result: SelectStmt = {
    kind: 'select',
    projections,
    from: tableRef,
    joins
  };
  if (where) result.where = where;
  if (limit !== undefined) result.limit = limit;
  return result;
}

const SELECT_CLAUSES = new Set(['select_clause', 'from_clause', 'where_clause', 'limit_clause']);
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL', 'GROUP_CONCAT']);
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%', '||']);
const COMPARISON_OPS: Record<string, BinaryExpr['op']> = {
  '=': '=', '==': '=', '!=': '!=', '<>': '!=',
  '<': '<', '<=': '<=', '>': '>', '>=': '>=', 'LIKE': 'LIKE',
};

function clauseLabel(type: string): string {
  return type.replace(/_clause$/, '').replace(/_/g, ' ').toUpperCase();
}

/** sql-parser-cst gives operators as a string, a keyword node, or a list of keywords. */
function operatorName(op: unknown): string {
  if (typeof op === 'string') return op.toUpperCase();
  if (Array.isArray(op)) return op.map(operatorName).join(' ');
  if (op && typeof op === 'object' && 'name' in op) return String((op as { name: unknown }).name).toUpperCase();
  return 'UNKNOWN';
}

function transformTableRef(node: CstNode): TableRef {
  if (node.type === 'identifier') return { table: node.name as string };
  if (node.type === 'alias' && node.expr?.type === 'identifier') {
    return { table: node.expr.name as string, alias: node.alias!.name as string };
  }
  const inner = node.type === 'alias' ? node.expr! : node;
  if (inner.type === 'paren_expr') throw new Error('Subqueries are not supported');
  throw new Error(`Unsupported table reference: ${inner.type}`);
}

function transformLimit(clause: CstNode): number {
  if (clause.offset) throw new Error('OFFSET is not supported');
  const count = clause.count;
  const value = count?.type === 'number_literal' ? count.value : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('LIMIT must be a non-negative integer');
  }
  return value;
}

function transformProjection(col: CstNode): Projection {
  if (col.type === 'star' || col.type === 'all_columns') {
    return { kind: 'star' };
  }

  const expr = col.type === 'alias' ? col.expr! : col;
  const alias = col.type === 'alias' ? col.alias!.name as string : undefined;

  if (expr.type === 'identifier') {
    const proj: Projection = { kind: 'col', column: expr.name! as string };
    if (alias) proj.alias = alias;
    return proj;
  } else if (expr.type === 'member_expr') {
    if (expr.property!.type === 'all_columns') {
      return { kind: 'star', table: expr.object!.name as string };
    }
    const proj: Projection = { kind: 'col', tableAlias: expr.object!.name! as string, column: expr.property!.name! as string };
    if (alias) proj.alias = alias;
    return proj;
  } else if (expr.type === 'func_call') {
    const fn = operatorName(expr.name);
    if (AGGREGATES.has(fn)) throw new Error(`Aggregate functions such as ${fn}() are not supported`);
    throw new Error(`Function calls such as ${fn}() are not supported`);
  } else if (expr.type === 'binary_expr' && ARITHMETIC_OPS.has(operatorName(expr.operator))) {
    throw new Error('Arithmetic expressions are not supported in SELECT');
  }

  throw new Error(`Only column names are supported in SELECT (got ${expr.type})`);
}

function transformInsert(stmt: CstNode): InsertStmt {
  let insertClause = stmt.clauses?.find((c: CstNode) => c.type === 'insert_clause');
  let valuesClause = stmt.clauses?.find((c: CstNode) => c.type === 'values_clause');

  if (!insertClause || !valuesClause) {
    throw new Error('INSERT must have INTO and VALUES');
  }

  const table = (insertClause!.table as CstNode).name as string;
  const columns = insertClause!.columns ? insertClause!.columns.expr!.items!.map((i: CstNode) => i.name! as string) : [];
  
  const values = valuesClause!.values!.items!.map((row: CstNode) => 
    row.expr!.items!.map((val: CstNode) => {
      const e = transformExpr(val);
      if (e.kind !== 'literal') throw new Error('VALUES must be literals');
      return e as Literal;
    })
  );

  return {
    kind: 'insert',
    table,
    columns,
    values
  };
}

function transformDelete(stmt: CstNode): DeleteStmt {
  let deleteClause = stmt.clauses?.find((c: CstNode) => c.type === 'delete_clause');
  let whereClause = stmt.clauses?.find((c: CstNode) => c.type === 'where_clause');

  if (!deleteClause) throw new Error('DELETE must have FROM');
  for (const clause of stmt.clauses ?? []) {
    if (clause.type !== 'delete_clause' && clause.type !== 'where_clause') {
      throw new Error(`${clauseLabel(clause.type)} is not supported in DELETE`);
    }
  }

  const tables = (deleteClause.tables as CstNode).items!;
  if (tables.length !== 1) throw new Error('DELETE supports exactly one table');
  const tableRef = transformTableRef(tables[0]!);
  if (tableRef.alias) throw new Error('Table aliases are not supported in DELETE');
  const table = tableRef.table;
  const where = whereClause ? transformExpr(whereClause.expr!) : undefined;

  const result: DeleteStmt = {
    kind: 'delete',
    table
  };
  if (where) result.where = where;
  return result;
}

function transformCreateTable(stmt: CstNode): CreateTableStmt {
  const table = (stmt.name as CstNode).name as string;
  const columns = stmt.columns!.expr!.items!.map((c: CstNode) => {
    let typeName = typeof c.dataType!.nameKw!.text === 'string' ? c.dataType!.nameKw!.text.toUpperCase() : 'UNKNOWN';
    let maxLen = c.dataType!.params ? c.dataType!.params!.expr!.items![0]!.value as number : undefined;
    
    let primaryKey = false;
    let notNull = false;
    
    if (c.constraints) {
      for (const cons of c.constraints) {
        if (cons.type === 'constraint_primary_key') primaryKey = true;
        if (cons.type === 'constraint_not_null') notNull = true;
      }
    }
    
    return {
      name: (c.name as CstNode).name as string,
      type: typeName,
      nullable: !notNull && !primaryKey,
      maxLen,
      primaryKey
    } as ColumnDefAST;
  });

  return {
    kind: 'create_table',
    table,
    columns
  };
}

function transformCreateIndex(stmt: CstNode): CreateIndexStmt {
  const indexName = (stmt.name as CstNode).name as string;
  const table = (stmt.table as CstNode).name as string;
  const column = (stmt.columns!.expr!.items![0]!.expr as CstNode).name as string; // Simplified single column
  return {
    kind: 'create_index',
    indexName,
    table,
    column
  };
}

function transformDropTable(stmt: CstNode): DropTableStmt {
  return {
    kind: 'drop_table',
    table: (stmt.name as CstNode).name as string
  };
}

function transformExplain(stmt: CstNode): ExplainStmt {
  // sql-parser-cst parses EXPLAIN stmt.
  // It usually has a `statement` property containing the inner statement.
  let analyze = false;
  let innerStmt = (stmt as any).statement || (stmt as any).stmt;
  
  if ((stmt as any).analyzeKw && ((stmt as any).analyzeKw as CstNode)?.text?.toUpperCase() === 'ANALYZE') {
    analyze = true;
  } else if ((stmt as any).explainKw && ((stmt as any).explainKw.name as CstNode)?.text?.toUpperCase() === 'EXPLAIN' && 
      (stmt as any).queryPlanKw && ((stmt as any).queryPlanKw.name as CstNode)?.text?.toUpperCase() === 'ANALYZE') {
    analyze = true;
  }
  
  return {
    kind: 'explain',
    analyze,
    stmt: transformStatement(innerStmt!)
  };
}

function transformAnalyze(stmt: CstNode): AnalyzeStmt {
  let table: string;
  if (stmt.tables && stmt.tables.items && stmt.tables.items.length > 0) {
    table = (stmt.tables.items[0]! as CstNode).name as string;
  } else {
    throw new Error('ANALYZE must specify a table');
  }
  return {
    kind: 'analyze',
    table
  };
}

function transformExpr(expr: CstNode): Expression {
  switch (expr.type) {
    case 'binary_expr': {
      const op = operatorName(expr.operator);
      if (op === 'AND' || op === 'OR') {
        return {
          kind: 'logical',
          op,
          left: transformExpr(expr.left!),
          right: transformExpr(expr.right!)
        };
      }
      const comparison = COMPARISON_OPS[op];
      if (!comparison) {
        if (ARITHMETIC_OPS.has(op)) throw new Error('Arithmetic expressions are not supported');
        throw new Error(`Operator ${op} is not supported`);
      }
      return {
        kind: 'binary',
        op: comparison,
        left: transformExpr(expr.left!),
        right: transformExpr(expr.right!)
      };
    }
    case 'paren_expr': {
      const inner = expr.expr!;
      if (inner.type === 'select_stmt' || inner.type === 'compound_select_stmt') {
        throw new Error('Subqueries are not supported');
      }
      return transformExpr(inner);
    }
    case 'prefix_op_expr': {
      const op = operatorName(expr.operator);
      const inner = expr.expr!;
      if ((op === '-' || op === '+') && inner.type === 'number_literal') {
        const value = inner.value as number;
        return { kind: 'literal', value: op === '-' ? -value : value };
      }
      throw new Error(`Operator ${op} is not supported`);
    }
    case 'between_expr':
      throw new Error('BETWEEN is not supported; use col >= a AND col <= b');
    case 'func_call':
      throw new Error(`Function calls such as ${operatorName(expr.name)}() are not supported`);
    case 'identifier':
      return { kind: 'column_ref', column: expr.name as string };
    case 'member_expr':
      return { kind: 'column_ref', table: expr.object!.name as string, column: expr.property!.name as string };
    case 'number_literal':
    case 'string_literal':
    case 'boolean_literal':
      return { kind: 'literal', value: expr.value as number | string | boolean };
    case 'null_literal':
      return { kind: 'literal', value: null };
    default:
      throw new Error(`Unsupported expression type: ${expr.type}`);
  }
}
