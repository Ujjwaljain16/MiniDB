// src/recovery/LogManager.ts — Phase 6

import { promises as fs } from 'fs';
import path from 'path';
import type { ILogManager, LogRecord } from '../common/interfaces.js';
import type { LSN } from '../common/types.js';
import { INVALID_LSN } from '../common/types.js';
import { encodeLogRecord, decodeLogRecord } from './LogRecord.js';

export class LogManager implements ILogManager {
  private logFileHandle: fs.FileHandle | null = null;
  private currentLsn_: LSN = 0 as unknown as LSN;
  private flushedLsn_: LSN = 0 as unknown as LSN;
  private initialized: boolean = false;
  
  private logBuffer: { lsn: LSN, data: Buffer }[] = [];
  
  constructor(private walPath: string) {}

  async init(): Promise<void> {
    if (this.logFileHandle) return;
    await fs.mkdir(path.dirname(this.walPath), { recursive: true });
    // Open for append and read
    this.logFileHandle = await fs.open(this.walPath, 'a+');
    const stat = await this.logFileHandle.stat();
    this.currentLsn_ = stat.size as unknown as LSN;
    this.flushedLsn_ = stat.size as unknown as LSN;
  }

  async append(record: Omit<LogRecord, 'lsn'>): Promise<LSN> {
    if (!this.logFileHandle) await this.init();

    // Assign LSN as the physical byte offset in the WAL file
    const lsn = this.currentLsn_;
    const encoded = encodeLogRecord({ ...record, lsn });
    
    this.logBuffer.push({ lsn, data: encoded });
    
    this.currentLsn_ = (Number(this.currentLsn_) + encoded.length) as unknown as LSN;

    return lsn;
  }

  async flush(upToLsn: LSN): Promise<void> {
    if (!this.logFileHandle) await this.init();
    
    if (Number(this.flushedLsn_) > Number(upToLsn)) {
      return;
    }

    const toWrite = this.logBuffer.filter(b => Number(b.lsn) <= Number(upToLsn));
    if (toWrite.length === 0) return;

    const data = Buffer.concat(toWrite.map(b => b.data));
    await this.logFileHandle!.appendFile(data);
    await this.logFileHandle!.datasync();

    const lastWritten = toWrite[toWrite.length - 1]!;
    this.flushedLsn_ = (Number(lastWritten.lsn) + lastWritten.data.length) as unknown as LSN;
    
    // Remove flushed buffers
    this.logBuffer = this.logBuffer.filter(b => Number(b.lsn) > Number(upToLsn));
  }

  async *iterator(fromLsn: LSN): AsyncIterableIterator<LogRecord> {
    if (!this.logFileHandle) await this.init();

    // Ensure everything is flushed before iterating (e.g. for SHOW WAL or redo)
    if (this.logBuffer.length > 0) {
      await this.flush(this.currentLsn_);
    }

    const stat = await this.logFileHandle!.stat();
    const fileSize = stat.size;
    let offset = Number(fromLsn);

    // Read chunks from the file
    const CHUNK_SIZE = 64 * 1024;
    let buffer = Buffer.alloc(0);

    while (offset < fileSize || buffer.length > 0) {
      // If buffer is empty or doesn't have enough data to parse at least the length, read more
      if (buffer.length < 8 + 8 + 4 + 1 + 1 /* minimum header size */ && offset < fileSize) {
        const readSize = Math.min(CHUNK_SIZE, fileSize - offset);
        const chunk = Buffer.alloc(readSize);
        const { bytesRead } = await this.logFileHandle!.read(chunk, 0, readSize, offset);
        offset += bytesRead;
        buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      }

      if (buffer.length === 0) break;

      // Try to decode. `decodeLogRecord` expects a complete record.
      // We can peek the `totalLen` if we read the end, but since it's variable length,
      // it's easier to just try decode. Wait, decodeLogRecord will throw or read out of bounds 
      // if the buffer doesn't contain the full record.
      // Let's implement a safe way: catch out of bounds error, read more and try again.
      try {
        const { record, bytesRead } = decodeLogRecord(buffer);
        yield record;
        buffer = buffer.subarray(bytesRead);
      } catch (e: any) {
        // RangeError: Index out of range means we need more data
        // RangeError: Index out of range means we need more data
        if (e instanceof RangeError || e.name === 'RangeError' || e.code === 'ERR_BUFFER_OUT_OF_BOUNDS' || e.code === 'ERR_OUT_OF_RANGE') {
          if (offset >= fileSize) {
            // Cannot read more, file is truncated or corrupted
            console.error(`WAL corrupted at offset ${Number(this.currentLsn_) - buffer.length}`);
            break;
          }
          // Read more data
          const readSize = Math.min(CHUNK_SIZE, fileSize - offset);
          const chunk = Buffer.alloc(readSize);
          const { bytesRead } = await this.logFileHandle!.read(chunk, 0, readSize, offset);
          offset += bytesRead;
          buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
        } else {
          throw e;
        }
      }
    }
  }

  currentLsn(): LSN {
    return this.currentLsn_;
  }

  async close(): Promise<void> {
    if (this.logBuffer.length > 0) {
      await this.flush(this.currentLsn_);
    }
    if (this.logFileHandle) {
      await this.logFileHandle.close();
      this.logFileHandle = null;
    }
    this.initialized = false;
  }
}

export class NullLogManager implements ILogManager {
  async append(_record: Omit<LogRecord, 'lsn'>): Promise<LSN> { return INVALID_LSN; }
  async flush(_upToLsn: LSN): Promise<void> {}
  async *iterator(_fromLsn: LSN): AsyncIterableIterator<LogRecord> {}
  currentLsn(): LSN { return INVALID_LSN; }
  async close(): Promise<void> {}
}
