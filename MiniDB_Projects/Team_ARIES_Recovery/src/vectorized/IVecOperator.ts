import type { ExecContext } from '../common/interfaces.js';
import type { DataChunk } from './DataChunk.js';

export interface IVecOperator {
  open(ctx: ExecContext): Promise<void>;
  nextBatch(): Promise<DataChunk | null>;
  close(): Promise<void>;
}
