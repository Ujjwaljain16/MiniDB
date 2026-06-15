import { parse } from 'sql-parser-cst';
import type { 
  Statement, SelectStmt, InsertStmt, DeleteStmt, CreateTableStmt, CreateIndexStmt, DropTableStmt,
  BeginStmt, CommitStmt, AbortStmt, ExplainStmt, AnalyzeStmt, ShowStmt,
  Expression, Projection, TableRef, JoinClause, ColumnDefAST, Literal
} from './AST.js';

export function parseSQL(sql: string): Statement {
  // We use the sqlite dialect
  let cst;
  try {
    cst = parse(sql, { dialect: 'sqlite' });
  } catch (err: any) {
    throw new Error(`Parse error: ${err.message}`);
  }

  if (cst.type !== 'program' || cst.statements.length === 0) {
    throw new Error('No SQL statements found');
  }

  if (cst.statements.length > 1) {
    throw new Error('Only single statements are supported');
  }

  return transformStatement(cst.statements[0]);
}

function transformStatement(stmt: any): Statement {
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
    // Analyze and Show are not native to sqlite CST, they might parse as arbitrary or we can intercept them
    default:
      // Try custom parsing for ANALYZE / SHOW if sql-parser-cst doesn't support them well
      throw new Error(`Unsupported statement type: ${stmt.type}`);
  }
}

// Transform SELECT
function transformSelect(stmt: any): SelectStmt {
  let selectClause = stmt.clauses.find((c: any) => c.type === 'select_clause');
  let fromClause = stmt.clauses.find((c: any) => c.type === 'from_clause');
  let whereClause = stmt.clauses.find((c: any) => c.type === 'where_clause');
  let limitClause = stmt.clauses.find((c: any) => c.type === 'limit_clause');

  if (!selectClause || !fromClause) {
    throw new Error('SELECT must have SELECT and FROM clauses');
  }

  const projections = selectClause.columns.items.map(transformProjection);
  
  // From clause handles the primary table and joins
  let primaryTableNode = fromClause.expr;
  // If it's a list (e.g. FROM a, b), we only support single table / explicit joins for now
  if (primaryTableNode.type === 'list_expr') {
    primaryTableNode = primaryTableNode.items[0];
  }
  let joins: JoinClause[] = [];
  
  if (primaryTableNode.type === 'join_expr') {
    // Unroll join_expr
    let current = primaryTableNode;
    let joinStack: any[] = [];
    while (current.type === 'join_expr') {
      joinStack.push(current);
      current = current.left;
    }
    
    primaryTableNode = current;
    
    // Process joins in order
    while (joinStack.length > 0) {
      const joinNode = joinStack.pop();
      const right = joinNode.right;
      let joinTable = right.type === 'alias' ? right.expr.name : right.name;
      let joinAlias = right.type === 'alias' ? right.alias.name : undefined;
      
      let onExpr: Expression;
      if (joinNode.specification && joinNode.specification.type === 'join_on_specification') {
        onExpr = transformExpr(joinNode.specification.expr);
      } else {
        throw new Error('INNER JOIN must have ON condition');
      }
      
      joins.push({
        table: joinTable,
        alias: joinAlias,
        on: onExpr
      });
    }
  }

  const tableRef: TableRef = {
    table: primaryTableNode.type === 'alias' ? primaryTableNode.expr.name : primaryTableNode.name,
    alias: primaryTableNode.type === 'alias' ? primaryTableNode.alias.name : undefined
  };

  const where = whereClause ? transformExpr(whereClause.expr) : undefined;
  const limit = limitClause ? limitClause.count.value : undefined;

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

function transformProjection(col: any): Projection {
  if (col.type === 'star') {
    return { kind: 'star' };
  }
  
  let expr = col.expr || col;
  let alias = col.alias ? col.alias.name : undefined;
  
  if (expr.type === 'identifier') {
    return { kind: 'col', column: expr.name, alias };
  } else if (expr.type === 'member_expr') {
    return { kind: 'col', tableAlias: expr.object.name, column: expr.property.name, alias };
  } else if (expr.type === 'all_columns') {
    return { kind: 'star' };
  }
  
  throw new Error(`Unsupported projection: ${expr.type}`);
}

function transformInsert(stmt: any): InsertStmt {
  let insertClause = stmt.clauses.find((c: any) => c.type === 'insert_clause');
  let valuesClause = stmt.clauses.find((c: any) => c.type === 'values_clause');

  if (!insertClause || !valuesClause) {
    throw new Error('INSERT must have INTO and VALUES');
  }

  const table = insertClause.table.name;
  const columns = insertClause.columns.expr.items.map((i: any) => i.name);
  
  const values = valuesClause.values.items.map((row: any) => 
    row.expr.items.map((val: any) => {
      const e = transformExpr(val);
      if (e.kind !== 'literal') throw new Error('VALUES must be literals');
      return e;
    })
  );

  return {
    kind: 'insert',
    table,
    columns,
    values
  };
}

function transformDelete(stmt: any): DeleteStmt {
  let deleteClause = stmt.clauses.find((c: any) => c.type === 'delete_clause');
  let whereClause = stmt.clauses.find((c: any) => c.type === 'where_clause');

  if (!deleteClause) throw new Error('DELETE must have FROM');

  const table = deleteClause.table.name;
  const where = whereClause ? transformExpr(whereClause.expr) : undefined;

  const result: DeleteStmt = {
    kind: 'delete',
    table
  };
  if (where) result.where = where;
  return result;
}

function transformCreateTable(stmt: any): CreateTableStmt {
  const table = stmt.name.name;
  const columns = stmt.columns.expr.items.map((c: any) => {
    let typeName = c.dataType.nameKw.text.toUpperCase();
    let maxLen = c.dataType.params ? c.dataType.params.expr.items[0].value : undefined;
    
    let primaryKey = false;
    let notNull = false;
    
    if (c.constraints) {
      for (const cons of c.constraints) {
        if (cons.type === 'constraint_primary_key') primaryKey = true;
        if (cons.type === 'constraint_not_null') notNull = true;
      }
    }
    
    return {
      name: c.name.name,
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

function transformCreateIndex(stmt: any): CreateIndexStmt {
  const indexName = stmt.name.name;
  const table = stmt.table.name;
  const column = stmt.columns.expr.items[0].expr.name; // Simplified single column
  return {
    kind: 'create_index',
    indexName,
    table,
    column
  };
}

function transformDropTable(stmt: any): DropTableStmt {
  return {
    kind: 'drop_table',
    table: stmt.name.name
  };
}

function transformExplain(stmt: any): ExplainStmt {
  // sql-parser-cst parses EXPLAIN stmt.
  // It usually has a `stmt` property containing the inner statement.
  let analyze = false;
  let innerStmt = stmt.stmt;
  
  if (stmt.explainKw && stmt.explainKw.text.toUpperCase() === 'EXPLAIN' && 
      stmt.queryPlanKw && stmt.queryPlanKw.text.toUpperCase() === 'ANALYZE') {
    // Some dialects parse EXPLAIN ANALYZE this way
    analyze = true;
  }
  
  return {
    kind: 'explain',
    analyze,
    stmt: transformStatement(innerStmt)
  };
}

function transformExpr(expr: any): Expression {
  switch (expr.type) {
    case 'binary_expr':
      const op = expr.operator.toUpperCase();
      if (['AND', 'OR'].includes(op)) {
        return {
          kind: 'logical',
          op: op as 'AND' | 'OR',
          left: transformExpr(expr.left),
          right: transformExpr(expr.right)
        };
      } else {
        return {
          kind: 'binary',
          op: op as any,
          left: transformExpr(expr.left),
          right: transformExpr(expr.right)
        };
      }
    case 'identifier':
      return { kind: 'column_ref', column: expr.name };
    case 'member_expr':
      return { kind: 'column_ref', table: expr.object.name, column: expr.property.name };
    case 'number_literal':
    case 'string_literal':
    case 'boolean_literal':
      return { kind: 'literal', value: expr.value };
    case 'null_literal':
      return { kind: 'literal', value: null };
    default:
      throw new Error(`Unsupported expression type: ${expr.type}`);
  }
}
