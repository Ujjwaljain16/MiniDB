// ─── src/MiniDB.ts ────────────────────────────────────────────────────────────
// Top-level facade. Wires all subsystems together.
// Implementation: Phase 9 (Integration Day).

import type { TxnId, ResultSet } from './common/index.js';

export class MiniDB {
  constructor(private readonly dataDir: string) {}

  async open(): Promise<void> {
    // Phase 9: Load catalog → init buffer pool → crash recovery → start deadlock detector
    throw new Error('Not yet implemented — Phase 9');
  }

  async execute(_sql: string, _txnId?: TxnId): Promise<ResultSet> {
    // Phase 9: parse → bind → logical plan → optimize → execute
    throw new Error('Not yet implemented — Phase 9');
  }

  async close(): Promise<void> {
    // Phase 9: stop deadlock detector → flush buffer pool → flush log → close files
    throw new Error('Not yet implemented — Phase 9');
  }
}
