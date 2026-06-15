// src/recovery/LogRecord.ts — Phase 6
// WAL log record type + binary encode/decode.

export type LogType = 'BEGIN' | 'INSERT' | 'DELETE' | 'UPDATE' | 'COMMIT' | 'ABORT' | 'CHECKPOINT';

// Re-export from interfaces for backwards compatibility
export type { LogRecord } from '../common/interfaces.js';
