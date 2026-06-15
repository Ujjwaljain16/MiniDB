import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { LogManager } from '../../../src/recovery/LogManager.js';
import { LogRecord } from '../../../src/recovery/LogRecord.js';
import { LSN, TxnId } from '../../../src/common/types.js';

describe('LogManager', () => {
  let walPath: string;
  let logManager: LogManager;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-test-'));
    walPath = path.join(tempDir, 'wal.log');
    logManager = new LogManager(walPath);
    await logManager.init();
  });

  afterEach(async () => {
    await logManager.close();
    try {
      await fs.unlink(walPath);
      await fs.rmdir(path.dirname(walPath));
    } catch (e) {}
  });

  it('appends and flushes records, then iterates over them', async () => {
    const r1: Omit<LogRecord, 'lsn'> = {
      prevLsn: 0 as unknown as LSN,
      txnId: 1 as TxnId,
      type: 'BEGIN',
    };

    const r2: Omit<LogRecord, 'lsn'> = {
      prevLsn: 0 as unknown as LSN, // actually would be r1.lsn, but just testing append
      txnId: 1 as TxnId,
      type: 'COMMIT',
    };

    const lsn1 = await logManager.append(r1);
    const lsn2 = await logManager.append(r2);

    expect(Number(lsn2)).toBeGreaterThan(Number(lsn1));

    await logManager.flush(lsn2);

    // Now iterate
    const records: LogRecord[] = [];
    for await (const rec of logManager.iterator(0 as unknown as LSN)) {
      records.push(rec);
    }

    expect(records.length).toBe(2);
    expect(records[0]!.type).toBe('BEGIN');
    expect(records[0]!.lsn).toBe(lsn1);
    expect(records[1]!.type).toBe('COMMIT');
    expect(records[1]!.lsn).toBe(lsn2);
  });
});
