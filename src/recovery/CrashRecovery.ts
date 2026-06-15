// src/recovery/CrashRecovery.ts — Phase 6
// ARIES-lite: analysis → redo → undo.

import type { ILogManager, IBufferPool, ITxnManager } from '../common/interfaces.js';

export async function recover(
  _logManager: ILogManager,
  _bufferPool: IBufferPool,
  _txnManager: ITxnManager,
): Promise<void> {
  throw new Error('CrashRecovery: not yet implemented — Phase 6');
}
