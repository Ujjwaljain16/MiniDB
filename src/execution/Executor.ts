// src/execution/Executor.ts — Phase 7

import type { ExecContext } from '../common/interfaces.js';
import type { ResultSet } from '../common/types.js';

export class Executor {
  async execute(_plan: unknown, _ctx: ExecContext): Promise<ResultSet> {
    throw new Error('Executor: not yet implemented — Phase 7');
  }
}
