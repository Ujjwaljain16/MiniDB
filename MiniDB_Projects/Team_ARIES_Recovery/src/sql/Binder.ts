import type { ICatalog, CatalogEntry } from '../common/interfaces.js';
import type { TableId } from '../common/types.js';
import type { 
  Statement, Expression, Projection, SelectStmt, InsertStmt, DeleteStmt
} from './AST.js';
import { 
  LogicalNode, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, 
  LogicalInsert, LogicalDelete, BoundExpression, BoundColumnRef, BoundLiteral,
  BoundBinaryExpr, BoundLogicalExpr
} from './LogicalPlan.js';

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

export class TypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeError';
  }
}

// Scope tracks available tables and aliases
interface Scope {
  tables: Map<string, { entry: CatalogEntry; alias?: string }>;
}

export class Binder {
  constructor(private readonly catalog: ICatalog) {}

  bind(stmt: Statement): LogicalNode {
    switch (stmt.kind) {
      case 'select': return this.bindSelect(stmt);
      case 'insert': return this.bindInsert(stmt);
      case 'delete': return this.bindDelete(stmt);
      default:
        // We only produce LogicalNodes for DML/DQL. DDL like CREATE TABLE is executed directly.
        throw new Error(`Cannot bind DDL statement to LogicalPlan: ${stmt.kind}`);
    }
  }

  private bindSelect(stmt: SelectStmt): LogicalNode {
    const scope: Scope = { tables: new Map() };
    
    // 1. Bind FROM
    const primaryEntry = this.getTable(stmt.from.table);
    const primaryRefName = stmt.from.alias || stmt.from.table;
    const scopeTableVal: { entry: CatalogEntry; alias?: string } = { entry: primaryEntry };
    if (stmt.from.alias) scopeTableVal.alias = stmt.from.alias;
    scope.tables.set(primaryRefName, scopeTableVal);
    
    let plan: LogicalNode = {
      kind: 'scan',
      tableId: primaryEntry.tableId,
      schema: primaryEntry.schema
    } as LogicalScan;
    if (stmt.from.alias) (plan as LogicalScan).alias = stmt.from.alias;

    // 2. Bind JOINs
    for (const join of stmt.joins) {
      const joinEntry = this.getTable(join.table);
      const joinRefName = join.alias || join.table;
      
      if (scope.tables.has(joinRefName)) {
        throw new BindError(`Table name or alias '${joinRefName}' is defined multiple times`);
      }
      const scopeJoinVal: { entry: CatalogEntry; alias?: string } = { entry: joinEntry };
      if (join.alias) scopeJoinVal.alias = join.alias;
      scope.tables.set(joinRefName, scopeJoinVal);
      
      const rightScan: LogicalScan = {
        kind: 'scan',
        tableId: joinEntry.tableId,
        schema: joinEntry.schema
      };
      if (join.alias) rightScan.alias = join.alias;
      
      const boundCondition = this.bindExpression(join.on, scope);
      this.checkType(boundCondition, 'BOOL'); // Condition must be boolean
      
      plan = {
        kind: 'join',
        left: plan,
        right: rightScan,
        condition: boundCondition,
        joinType: 'inner'
      };
    }

    // 3. Bind WHERE
    if (stmt.where) {
      const boundWhere = this.bindExpression(stmt.where, scope);
      // Wait, SQLite doesn't strictly have a BOOL type (uses INT). MiniDB has BOOL.
      // If we use BOOL type for expressions like `amount > 100`, that is fine.
      this.checkType(boundWhere, 'BOOL');
      plan = {
        kind: 'filter',
        child: plan,
        predicate: boundWhere
      };
    }

    // 4. Bind Projections
    const boundProjections: BoundExpression[] = [];
    for (const proj of stmt.projections) {
      if (proj.kind === 'star') {
        // Expand star to all columns in scope
        for (const [refName, { entry }] of scope.tables.entries()) {
          for (let i = 0; i < entry.schema.length; i++) {
            const col = entry.schema[i]!;
            const boundCol: BoundColumnRef = {
              kind: 'bound_col',
              tableId: entry.tableId,
              columnName: col.name,
              columnIndex: i,
              type: col.type
            };
            if (refName !== entry.tableId as string) boundCol.tableAlias = refName;
            boundProjections.push(boundCol);
          }
        }
      } else {
        const boundCol = this.resolveColumn(proj.tableAlias, proj.column, scope);
        if (proj.alias) boundCol.alias = proj.alias;
        boundProjections.push(boundCol);
      }
    }

    plan = {
      kind: 'project',
      child: plan,
      projections: boundProjections
    };

    return plan;
  }

  private bindInsert(stmt: InsertStmt): LogicalInsert {
    const entry = this.getTable(stmt.table);
    
    const cols = (stmt.columns && stmt.columns.length > 0) ? stmt.columns : entry.schema.map(c => c.name);
    
    // Check columns
    const colIndices: number[] = [];
    for (const colName of cols) {
      const idx = entry.schema.findIndex(c => c.name === colName);
      if (idx === -1) throw new BindError(`Column '${colName}' not found in table '${stmt.table}'`);
      colIndices.push(idx);
    }
    
    const boundValues: BoundExpression[][] = [];
    for (const row of stmt.values) {
      if (row.length !== cols.length) {
        throw new BindError(`INSERT has ${row.length} values but ${cols.length} columns`);
      }
      
      const boundRow = row.map((val, i) => {
        const boundVal = this.bindExpression(val, { tables: new Map() }); // no scope for literals
        const expectedType = entry.schema[colIndices[i]!]!.type;
        // Strict type checking for inserts
        this.checkType(boundVal, expectedType);
        return boundVal;
      });
      boundValues.push(boundRow);
    }

    return {
      kind: 'insert',
      tableId: entry.tableId,
      columns: stmt.columns,
      values: boundValues
    };
  }

  private bindDelete(stmt: DeleteStmt): LogicalDelete {
    const entry = this.getTable(stmt.table);
    const scope: Scope = { tables: new Map() };
    scope.tables.set(stmt.table, { entry });

    let plan: LogicalNode = {
      kind: 'scan',
      tableId: entry.tableId,
      schema: entry.schema
    };

    if (stmt.where) {
      const boundWhere = this.bindExpression(stmt.where, scope);
      this.checkType(boundWhere, 'BOOL');
      plan = {
        kind: 'filter',
        child: plan,
        predicate: boundWhere
      };
    }

    return {
      kind: 'delete',
      tableId: entry.tableId,
      child: plan
    };
  }

  private bindExpression(expr: Expression, scope: Scope): BoundExpression {
    switch (expr.kind) {
      case 'literal':
        return {
          kind: 'bound_literal',
          value: expr.value,
          type: this.inferLiteralType(expr.value)
        };
      
      case 'column_ref':
        return this.resolveColumn(expr.table, expr.column, scope);
        
      case 'binary':
        const left = this.bindExpression(expr.left, scope);
        const right = this.bindExpression(expr.right, scope);
        
        const leftType = this.getExprType(left);
        const rightType = this.getExprType(right);
        // Type compatibility check
        if (leftType !== rightType && leftType !== 'UNKNOWN' && rightType !== 'UNKNOWN') {
          throw new TypeError(`Cannot compare ${leftType} and ${rightType}`);
        }
        
        return {
          kind: 'bound_binary',
          op: expr.op,
          left,
          right
        };
        // Wait, our BoundExpression doesn't have `type` field on all nodes, only bound_col and bound_literal
        // I will just return it. 
        
      case 'logical':
        const lLeft = this.bindExpression(expr.left, scope);
        const lRight = this.bindExpression(expr.right, scope);
        return {
          kind: 'bound_logical',
          op: expr.op,
          left: lLeft,
          right: lRight
        };
    }
  }

  private resolveColumn(tableName: string | undefined, columnName: string, scope: Scope): BoundColumnRef {
    let matches: { tableRefName: string, entry: CatalogEntry, colIndex: number }[] = [];

    for (const [refName, { entry }] of scope.tables.entries()) {
      if (tableName && tableName !== refName) continue;
      
      const colIndex = entry.schema.findIndex(c => c.name === columnName);
      if (colIndex !== -1) {
        matches.push({ tableRefName: refName, entry, colIndex });
      }
    }

    if (matches.length === 0) {
      const q = tableName ? `${tableName}.${columnName}` : columnName;
      throw new BindError(`Column '${q}' not found`);
    }

    if (matches.length > 1) {
      throw new BindError(`Column '${columnName}' is ambiguous`);
    }

    const match = matches[0]!;
    const result: BoundColumnRef = {
      kind: 'bound_col',
      tableId: match.entry.tableId,
      columnName,
      columnIndex: match.colIndex,
      type: match.entry.schema[match.colIndex]!.type
    };
    if (match.tableRefName !== match.entry.tableId as string) {
      result.tableAlias = match.tableRefName;
    }
    return result;
  }

  private getTable(tableName: string): CatalogEntry {
    try {
      return this.catalog.getTable(tableName as TableId);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('NotFoundError')) {
        throw new BindError(`Table '${tableName}' not found`);
      }
      throw e;
    }
  }

  private inferLiteralType(val: unknown): string {
    if (typeof val === 'number') return Number.isInteger(val) ? 'INT' : 'FLOAT';
    if (typeof val === 'string') return 'VARCHAR';
    if (typeof val === 'boolean') return 'BOOL';
    return 'UNKNOWN'; // NULL
  }

  private checkType(expr: BoundExpression, expected: string) {
    let actual = this.getExprType(expr);
    if (actual !== expected && actual !== 'UNKNOWN') {
      throw new TypeError(`Expected ${expected}, got ${actual}`);
    }
  }

  private getExprType(expr: BoundExpression): string {
    switch (expr.kind) {
      case 'bound_col': return expr.type;
      case 'bound_literal': return expr.type;
      case 'bound_binary': return 'BOOL';
      case 'bound_logical': return 'BOOL';
    }
  }
}
