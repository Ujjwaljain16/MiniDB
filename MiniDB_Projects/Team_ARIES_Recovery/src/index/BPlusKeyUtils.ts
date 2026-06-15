import type { PageId, RID, ColValue, ColType, ColumnDef } from '../common/types.js';
import { NULL_PAGE_ID, encodeRID, decodeRID } from '../common/types.js';
import { PAGE_SIZE } from '../common/config.js';

export function getKeySize(colDef: ColumnDef): number {
  if (colDef.type === 'VARCHAR') return 2 + (colDef.maxLen ?? 255);
  if (colDef.type === 'INT') return 4;
  if (colDef.type === 'BIGINT') return 8;
  if (colDef.type === 'FLOAT') return 8;
  if (colDef.type === 'BOOL') return 1;
  return 4;
}

export function writeKey(buf: Buffer, offset: number, key: ColValue, colDef: ColumnDef): void {
  if (key === null) {
    // For simplicity, we just zero it out or assume B+ Tree doesn't index nulls.
    // If it does, we'd need a null byte. Assume no nulls in index for now.
    buf.fill(0, offset, offset + getKeySize(colDef));
    return;
  }
  
  switch (colDef.type) {
    case 'INT':
      buf.writeInt32LE(key as number, offset);
      break;
    case 'BIGINT':
      buf.writeBigInt64LE(BigInt(key as number | bigint), offset);
      break;
    case 'FLOAT':
      buf.writeDoubleLE(key as number, offset);
      break;
    case 'BOOL':
      buf.writeUInt8(key ? 1 : 0, offset);
      break;
    case 'VARCHAR':
      const str = String(key);
      const strBytes = Buffer.byteLength(str, 'utf8');
      buf.writeUInt16LE(strBytes, offset);
      buf.write(str, offset + 2, strBytes, 'utf8');
      // pad rest with 0
      buf.fill(0, offset + 2 + strBytes, offset + getKeySize(colDef));
      break;
  }
}

export function readKey(buf: Buffer, offset: number, colDef: ColumnDef): ColValue {
  switch (colDef.type) {
    case 'INT':
      return buf.readInt32LE(offset);
    case 'BIGINT':
      return buf.readBigInt64LE(offset);
    case 'FLOAT':
      return buf.readDoubleLE(offset);
    case 'BOOL':
      return buf.readUInt8(offset) !== 0;
    case 'VARCHAR':
      const len = buf.readUInt16LE(offset);
      return buf.toString('utf8', offset + 2, offset + 2 + len);
    default:
      return 0;
  }
}

export function compareKeys(a: ColValue, b: ColValue, colDef: ColumnDef): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  
  if (colDef.type === 'VARCHAR') {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  if (colDef.type === 'BIGINT') {
    const ba = BigInt(a as number | bigint);
    const bb = BigInt(b as number | bigint);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  const na = a as number;
  const nb = b as number;
  return na < nb ? -1 : na > nb ? 1 : 0;
}
