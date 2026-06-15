// src/recovery/CheckpointManager.ts — Phase 6
// Fuzzy checkpoint: write dirty page table + active txn table to WAL.
export class CheckpointManager {
  constructor(_logManager: unknown, _bufferPool: unknown, _txnManager: unknown) {
    throw new Error('CheckpointManager: not yet implemented — Phase 6');
  }
  async writeCheckpoint(): Promise<void> { throw new Error('NYI'); }
  async readLastCheckpoint(): Promise<unknown> { throw new Error('NYI'); }
}
