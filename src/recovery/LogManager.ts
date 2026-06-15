// src/recovery/LogManager.ts — Phase 6

import type { ILogManager, LogRecord } from '../common/interfaces.js';
import type { LSN } from '../common/types.js';
import { INVALID_LSN } from '../common/types.js';

export class LogManager implements ILogManager {
  private _currentLsn: LSN = INVALID_LSN;

  constructor(_walPath: string) {
    throw new Error('LogManager: not yet implemented — Phase 6');
  }
  append(_record: Omit<LogRecord, 'lsn'>): Promise<LSN> { throw new Error('NYI'); }
  flush(_upToLsn: LSN): Promise<void> { throw new Error('NYI'); }
  async *iterator(_fromLsn: LSN): AsyncIterableIterator<LogRecord> { throw new Error('NYI'); }
  currentLsn(): LSN { return this._currentLsn; }
  close(): Promise<void> { throw new Error('NYI'); }
}

export class NullLogManager implements ILogManager {
  async append(_record: Omit<LogRecord, 'lsn'>): Promise<LSN> {
    return INVALID_LSN;
  }

  async flush(_upToLsn: LSN): Promise<void> {
    // No-op
  }
  
  async *iterator(_fromLsn: LSN): AsyncIterableIterator<LogRecord> {}
  currentLsn(): LSN { return INVALID_LSN; }
  async close(): Promise<void> {}
}
