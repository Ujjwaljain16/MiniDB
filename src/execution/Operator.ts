// src/execution/Operator.ts — Phase 7
// Abstract base implementing IOperator.

import type { IOperator, ExecContext } from '../common/interfaces.js';
import type { Tuple } from '../common/types.js';

export abstract class Operator implements IOperator {
  protected ctx!: ExecContext;

  abstract open(ctx: ExecContext): Promise<void>;
  abstract next(): Promise<Tuple | null>;
  abstract close(): Promise<void>;
}
