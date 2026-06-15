import type { Schema, ColType } from '../common/types.js';

export const BATCH_SIZE = 1024;

export class VarcharBuffer {
  public offsets: Int32Array;
  public data: Uint8Array;
  public dataCapacity: number;

  constructor() {
    this.offsets = new Int32Array(BATCH_SIZE + 1);
    this.dataCapacity = 4096;
    this.data = new Uint8Array(this.dataCapacity);
  }

  append(rowIdx: number, strBytes: Buffer): void {
    const len = strBytes.length;
    const currentOffset = this.offsets[rowIdx]!;
    const newOffset = currentOffset + len;

    // Expand buffer if necessary
    while (newOffset > this.dataCapacity) {
      this.dataCapacity *= 2;
      const newData = new Uint8Array(this.dataCapacity);
      newData.set(this.data);
      this.data = newData;
    }

    this.data.set(strBytes, currentOffset);
    this.offsets[rowIdx + 1] = newOffset;
  }

  getString(rowIdx: number): string | null {
    const start = this.offsets[rowIdx]!;
    const end = this.offsets[rowIdx + 1]!;
    if (end === start) return "";
    return Buffer.from(this.data.buffer, this.data.byteOffset + start, end - start).toString('utf8');
  }
}

export type PrimitiveTypedArray = Int32Array | BigInt64Array | Float64Array | Uint8Array;

export interface ColumnVector {
  values: PrimitiveTypedArray | VarcharBuffer;
  nullMask: Uint8Array; // 1 = null, 0 = valid
}

export class DataChunk {
  public numRows: number = 0;
  public columns: ColumnVector[];
  public selectionVector: Uint8Array; // 1 = active, 0 = filtered

  constructor(public readonly schema: Schema) {
    this.columns = schema.map(col => ({
      values: allocForType(col.type),
      nullMask: new Uint8Array(BATCH_SIZE)
    }));
    this.selectionVector = new Uint8Array(BATCH_SIZE).fill(1);
  }

  reset(): void {
    this.numRows = 0;
    this.selectionVector.fill(1);
    for (const col of this.columns) {
      col.nullMask.fill(0); // clear nulls
      if (col.values instanceof VarcharBuffer) {
        // Reset offsets array, data array can remain as is, it will be overwritten
        col.values.offsets[0] = 0;
      }
    }
  }
}

export function allocForType(type: ColType): PrimitiveTypedArray | VarcharBuffer {
  switch (type) {
    case 'INT':    return new Int32Array(BATCH_SIZE);
    case 'BIGINT': return new BigInt64Array(BATCH_SIZE);
    case 'FLOAT':  return new Float64Array(BATCH_SIZE);
    case 'BOOL':   return new Uint8Array(BATCH_SIZE);
    case 'VARCHAR': return new VarcharBuffer();
  }
}
