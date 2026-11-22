import type { ILogManager, LogRecord } from '../common/interfaces.js';
import type { LSN } from '../common/types.js';
import { encodeLogRecord, decodeLogRecord } from './LogRecord.js';

/**
 * WAL kept in memory. Records are stored encoded, and an LSN is the record's
 * byte offset in the log, exactly as with the file-backed LogManager.
 */
export class MemLogManager implements ILogManager {
  private records: { lsn: number; data: Buffer }[] = [];
  private endLsn = 0;

  async append(record: Omit<LogRecord, 'lsn'>): Promise<LSN> {
    const lsn = this.endLsn as unknown as LSN;
    const data = encodeLogRecord({ ...record, lsn });
    this.records.push({ lsn: this.endLsn, data });
    this.endLsn += data.length;
    return lsn;
  }

  async flush(_upToLsn: LSN): Promise<void> {}

  async *iterator(fromLsn: LSN): AsyncIterableIterator<LogRecord> {
    // Like the file log, only records that existed when iteration started are visited
    const end = this.records.length;
    for (let i = 0; i < end; i++) {
      const entry = this.records[i]!;
      if (entry.lsn >= Number(fromLsn)) yield decodeLogRecord(entry.data).record;
    }
  }

  currentLsn(): LSN {
    return this.endLsn as unknown as LSN;
  }

  async close(): Promise<void> {}
}
