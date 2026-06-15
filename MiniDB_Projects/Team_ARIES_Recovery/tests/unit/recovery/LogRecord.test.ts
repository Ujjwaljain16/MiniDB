import { encodeLogRecord, decodeLogRecord, LogRecord } from '../../../src/recovery/LogRecord.js';
import { LSN, TxnId, TableId, PageId, SlotId } from '../../../src/common/types.js';

describe('LogRecord', () => {
  it('encodes and decodes a BEGIN record', () => {
    const record: LogRecord = {
      lsn: 10 as unknown as LSN,
      prevLsn: 0 as unknown as LSN,
      txnId: 5 as TxnId,
      type: 'BEGIN',
    };

    const encoded = encodeLogRecord(record);
    const { record: decoded } = decodeLogRecord(encoded);

    expect(decoded.lsn).toBe(record.lsn);
    expect(decoded.prevLsn).toBe(record.prevLsn);
    expect(decoded.txnId).toBe(record.txnId);
    expect(decoded.type).toBe(record.type);
    expect(decoded.tableId).toBeUndefined();
    expect(decoded.rid).toBeUndefined();
    expect(decoded.beforeImage).toBeUndefined();
    expect(decoded.afterImage).toBeUndefined();
  });

  it('encodes and decodes an UPDATE record with full data', () => {
    const record: LogRecord = {
      lsn: 25 as unknown as LSN,
      prevLsn: 10 as unknown as LSN,
      txnId: 5 as TxnId,
      type: 'UPDATE',
      tableId: 'users' as TableId,
      rid: { pageId: 100 as PageId, slotId: 2 as SlotId },
      beforeImage: Buffer.from('old_data'),
      afterImage: Buffer.from('new_data'),
    };

    const encoded = encodeLogRecord(record);
    const { record: decoded } = decodeLogRecord(encoded);

    expect(decoded.lsn).toBe(record.lsn);
    expect(decoded.prevLsn).toBe(record.prevLsn);
    expect(decoded.txnId).toBe(record.txnId);
    expect(decoded.type).toBe(record.type);
    expect(decoded.tableId).toBe(record.tableId);
    expect(decoded.rid).toEqual(record.rid);
    expect(decoded.beforeImage?.toString()).toBe('old_data');
    expect(decoded.afterImage?.toString()).toBe('new_data');
  });
});
