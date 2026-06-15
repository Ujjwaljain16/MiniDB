import type { TableId, IndexId, Schema } from '../common/types.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';

export type PhysicalNode =
  | PhysSeqScan
  | PhysIndexScan
  | PhysFilter
  | PhysProject
  | PhysNLJ
  | PhysHashJoin
  | PhysInsert
  | PhysDelete;

export interface PhysBase {
  estRows: number;
  estCost: number;
}

export interface PhysSeqScan extends PhysBase {
  kind: 'phys_seq_scan';
  tableId: TableId;
  schema: Schema;
  alias?: string;
}

export interface PhysIndexScan extends PhysBase {
  kind: 'phys_index_scan';
  tableId: TableId;
  indexId: IndexId;
  schema: Schema;
  alias?: string;
  // Extracted key condition
  keyCondition?: BoundExpression; 
}

export interface PhysFilter extends PhysBase {
  kind: 'phys_filter';
  child: PhysicalNode;
  predicate: BoundExpression;
}

export interface PhysProject extends PhysBase {
  kind: 'phys_project';
  child: PhysicalNode;
  projections: BoundExpression[];
}

export interface PhysNLJ extends PhysBase {
  kind: 'phys_nlj';
  left: PhysicalNode;
  right: PhysicalNode;
  condition: BoundExpression;
}

export interface PhysHashJoin extends PhysBase {
  kind: 'phys_hash_join';
  left: PhysicalNode;
  right: PhysicalNode;
  condition: BoundExpression;
}

export interface PhysInsert extends PhysBase {
  kind: 'phys_insert';
  tableId: TableId;
  columns: string[];
  values: BoundExpression[][];
}

export interface PhysDelete extends PhysBase {
  kind: 'phys_delete';
  tableId: TableId;
  child: PhysicalNode;
}
