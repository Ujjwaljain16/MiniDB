export type Statement =
  | SelectStmt
  | InsertStmt
  | DeleteStmt
  | CreateTableStmt
  | CreateIndexStmt
  | DropTableStmt
  | BeginStmt
  | CommitStmt
  | AbortStmt
  | ExplainStmt
  | AnalyzeStmt
  | ShowStmt;

export interface SelectStmt {
  kind: 'select';
  projections: Projection[];
  from: TableRef;
  joins: JoinClause[];
  where?: Expression;
  limit?: number;
}

export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns: string[];
  values: Literal[][]; // Or primitive arrays
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  where?: Expression;
}

export interface CreateTableStmt {
  kind: 'create_table';
  table: string;
  columns: ColumnDefAST[];
}

export interface ColumnDefAST {
  name: string;
  type: string; // 'INT' | 'BIGINT' | 'FLOAT' | 'BOOL' | 'VARCHAR'
  nullable: boolean;
  maxLen?: number;
  primaryKey: boolean;
}

export interface CreateIndexStmt {
  kind: 'create_index';
  indexName: string;
  table: string;
  column: string;
}

export interface DropTableStmt {
  kind: 'drop_table';
  table: string;
}

export interface BeginStmt { kind: 'begin'; }
export interface CommitStmt { kind: 'commit'; }
export interface AbortStmt { kind: 'abort'; }

export interface ExplainStmt {
  kind: 'explain';
  analyze: boolean;
  stmt: Statement;
}

export interface AnalyzeStmt {
  kind: 'analyze';
  table: string;
}

export interface ShowStmt {
  kind: 'show';
  target: 'BUFFER_POOL' | 'WAL';
}

export type Expression =
  | BinaryExpr
  | LogicalExpr
  | ColumnRef
  | Literal;

export interface BinaryExpr {
  kind: 'binary';
  op: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'LIKE'; // No BETWEEN for now, can be desugared to LogicalExpr
  left: Expression;
  right: Expression;
}

export interface LogicalExpr {
  kind: 'logical';
  op: 'AND' | 'OR';
  left: Expression;
  right: Expression;
}

export interface ColumnRef {
  kind: 'column_ref';
  table?: string;
  column: string;
}

export interface Literal {
  kind: 'literal';
  value: number | string | boolean | null;
}

export type Projection =
  | { kind: 'star' }
  | { kind: 'col'; tableAlias?: string; column: string; alias?: string };

export interface TableRef {
  table: string;
  alias?: string;
}

export interface JoinClause {
  table: string;
  alias?: string;
  // Inner join only
  on: Expression;
}
