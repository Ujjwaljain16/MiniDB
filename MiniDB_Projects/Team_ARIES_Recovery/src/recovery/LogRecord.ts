// src/recovery/LogRecord.ts — Phase 6
// WAL log record type + binary encode/decode.

import type { LSN, TxnId, TableId, RID } from '../common/types.js';

export type LogType = 'BEGIN' | 'INSERT' | 'DELETE' | 'UPDATE' | 'COMMIT' | 'ABORT' | 'CHECKPOINT';

export interface LogRecord {
  lsn:          LSN;
  prevLsn:      LSN;
  txnId:        TxnId;
  type:         LogType;
  tableId?:     TableId;
  rid?:         RID;
  beforeImage?: Buffer;
  afterImage?:  Buffer;
}

const LOG_TYPE_MAP: Record<LogType, number> = {
  BEGIN: 1,
  INSERT: 2,
  DELETE: 3,
  UPDATE: 4,
  COMMIT: 5,
  ABORT: 6,
  CHECKPOINT: 7,
};

const INV_LOG_TYPE_MAP: Record<number, LogType> = Object.fromEntries(
  Object.entries(LOG_TYPE_MAP).map(([k, v]) => [v, k as LogType])
);

export function encodeLogRecord(record: LogRecord): Buffer {
  let size = 8 + 8 + 4 + 1; // lsn(8) + prevLsn(8) + txnId(4) + type(1)
  
  const tableIdBuffer = record.tableId ? Buffer.from(record.tableId, 'utf8') : Buffer.alloc(0);
  size += 1 + tableIdBuffer.length; // tableIdLen(1) + tableId

  size += 1; // ridPresent(1)
  if (record.rid) {
    size += 4 + 2; // pageId(4) + slotId(2)
  }

  size += 4; // beforeLen(4)
  if (record.beforeImage) {
    size += record.beforeImage.length;
  }

  size += 4; // afterLen(4)
  if (record.afterImage) {
    size += record.afterImage.length;
  }

  size += 4; // totalLen(4)

  const buf = Buffer.alloc(size);
  let offset = 0;

  buf.writeBigInt64LE(BigInt(record.lsn), offset); offset += 8;
  buf.writeBigInt64LE(BigInt(record.prevLsn), offset); offset += 8;
  buf.writeUInt32LE(record.txnId, offset); offset += 4;
  buf.writeUInt8(LOG_TYPE_MAP[record.type]!, offset); offset += 1;

  buf.writeUInt8(tableIdBuffer.length, offset); offset += 1;
  if (tableIdBuffer.length > 0) {
    tableIdBuffer.copy(buf, offset);
    offset += tableIdBuffer.length;
  }

  if (record.rid) {
    buf.writeUInt8(1, offset); offset += 1;
    buf.writeUInt32LE(record.rid.pageId, offset); offset += 4;
    buf.writeUInt16LE(record.rid.slotId, offset); offset += 2;
  } else {
    buf.writeUInt8(0, offset); offset += 1;
  }

  if (record.beforeImage) {
    buf.writeUInt32LE(record.beforeImage.length, offset); offset += 4;
    record.beforeImage.copy(buf, offset); offset += record.beforeImage.length;
  } else {
    buf.writeUInt32LE(0, offset); offset += 4;
  }

  if (record.afterImage) {
    buf.writeUInt32LE(record.afterImage.length, offset); offset += 4;
    record.afterImage.copy(buf, offset); offset += record.afterImage.length;
  } else {
    buf.writeUInt32LE(0, offset); offset += 4;
  }

  buf.writeUInt32LE(size, offset); // trailing total length
  return buf;
}

export function decodeLogRecord(buf: Buffer): { record: LogRecord, bytesRead: number } {
  let offset = 0;

  const lsn = Number(buf.readBigInt64LE(offset)) as LSN; offset += 8;
  const prevLsn = Number(buf.readBigInt64LE(offset)) as LSN; offset += 8;
  const txnId = buf.readUInt32LE(offset) as TxnId; offset += 4;
  const typeId = buf.readUInt8(offset); offset += 1;
  const type = INV_LOG_TYPE_MAP[typeId]!;

  const tableIdLen = buf.readUInt8(offset); offset += 1;
  let tableId: TableId | undefined = undefined;
  if (tableIdLen > 0) {
    tableId = buf.subarray(offset, offset + tableIdLen).toString('utf8') as TableId;
    offset += tableIdLen;
  }

  const ridPresent = buf.readUInt8(offset); offset += 1;
  let rid: RID | undefined = undefined;
  if (ridPresent) {
    const pageId = buf.readUInt32LE(offset) as any; offset += 4;
    const slotId = buf.readUInt16LE(offset) as any; offset += 2;
    rid = { pageId, slotId };
  }

  const beforeLen = buf.readUInt32LE(offset); offset += 4;
  let beforeImage: Buffer | undefined = undefined;
  if (beforeLen > 0) {
    beforeImage = Buffer.alloc(beforeLen);
    buf.copy(beforeImage, 0, offset, offset + beforeLen);
    offset += beforeLen;
  }

  const afterLen = buf.readUInt32LE(offset); offset += 4;
  let afterImage: Buffer | undefined = undefined;
  if (afterLen > 0) {
    afterImage = Buffer.alloc(afterLen);
    buf.copy(afterImage, 0, offset, offset + afterLen);
    offset += afterLen;
  }

  // offset + 4 is totalLen, we don't need to read it during normal forward decode
  // as the caller will pass the correctly sliced buffer.

  const result: LogRecord = {
    lsn,
    prevLsn,
    txnId,
    type,
  };

  if (tableId !== undefined) result.tableId = tableId;
  if (rid !== undefined) result.rid = rid;
  if (beforeImage !== undefined) result.beforeImage = beforeImage;
  if (afterImage !== undefined) result.afterImage = afterImage;

  // read the trailing totalLen
  const totalLen = buf.readUInt32LE(offset); offset += 4;

  return { record: result, bytesRead: offset };
}
