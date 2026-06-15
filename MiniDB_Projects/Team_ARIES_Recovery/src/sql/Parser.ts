import { parse } from 'sql-parser-cst';
import type { 
  Statement, SelectStmt, InsertStmt, DeleteStmt, CreateTableStmt, CreateIndexStmt, DropTableStmt,
  BeginStmt, CommitStmt, AbortStmt, ExplainStmt, AnalyzeStmt, ShowStmt,
  Expression, Projection, TableRef, JoinClause, ColumnDefAST, Literal
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

  if (!selectClause || !fromClause) {
    throw new Error('SELECT must have SELECT and FROM clauses');
  }

  const projections = selectClause.columns!.items!.map(transformProjection);
  
  // From clause handles the primary table and joins
  let primaryTableNode = fromClause.expr!;
  // If it's a list (e.g. FROM a, b), we only support single table / explicit joins for now
  if (primaryTableNode.type === 'list_expr') {
    primaryTableNode = primaryTableNode.items![0]!;
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
      const right = joinNode.right!;
      let joinTable = right.type === 'alias' ? (right.expr as CstNode).name as string : right.name as string;
      let joinAlias = right.type === 'alias' ? (right.alias as CstNode).name as string : undefined;
      
      let onExpr: Expression;
      if (joinNode.specification && joinNode.specification.type === 'join_on_specification') {
        onExpr = transformExpr(joinNode.specification.expr!);
      } else {
        throw new Error('INNER JOIN must have ON condition');
      }
      
      const joinClause: JoinClause = {
        table: joinTable,
        on: onExpr
      };
      if (joinAlias) joinClause.alias = joinAlias;
      joins.push(joinClause);
    }
  }

  const tableRef: TableRef = {
    table: primaryTableNode.type === 'alias' ? (primaryTableNode.expr!.name! as string) : (primaryTableNode.name! as string)
  };
  if (primaryTableNode.type === 'alias') tableRef.alias = primaryTableNode.alias!.name! as string;

  const where = whereClause ? transformExpr(whereClause.expr!) : undefined;
  const limit = limitClause ? limitClause.count!.value as number : undefined;

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

function transformProjection(col: CstNode): Projection {
  if (col.type === 'star') {
    return { kind: 'star' };
  }
  
  let expr = col.expr || col;
  let alias = col.alias ? col.alias.name! as string : undefined;
  
  if (expr.type === 'identifier') {
    const proj: Projection = { kind: 'col', column: expr.name! as string };
    if (alias) proj.alias = alias;
    return proj;
  } else if (expr.type === 'member_expr') {
    const proj: Projection = { kind: 'col', tableAlias: expr.object!.name! as string, column: expr.property!.name! as string };
    if (alias) proj.alias = alias;
    return proj;
  } else if (expr.type === 'all_columns') {
    return { kind: 'star' };
  }
  
  throw new Error(`Unsupported projection: ${expr.type}`);
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

  const table = (deleteClause.tables as CstNode).items![0]!.name as string;
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
    case 'binary_expr':
      const op = typeof expr.operator === 'string' ? expr.operator.toUpperCase() : 'UNKNOWN';
      if (['AND', 'OR'].includes(op)) {
        return {
          kind: 'logical',
          op: op as 'AND' | 'OR',
          left: transformExpr(expr.left!),
          right: transformExpr(expr.right!)
        };
      } else {
        return {
          kind: 'binary',
          op: op as '=' | '!=' | '<' | '>' | '<=' | '>=' | 'LIKE',
          left: transformExpr(expr.left!),
          right: transformExpr(expr.right!)
        };
      }
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
