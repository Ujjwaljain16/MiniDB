import type { IVecOperator } from './IVecOperator.js';
import { DataChunk, BATCH_SIZE, VarcharBuffer, PrimitiveTypedArray } from './DataChunk.js';
import type { PhysSeqScan } from '../optimizer/PhysicalPlan.js';
import type { ExecContext } from '../common/interfaces.js';
import { LockMode } from '../common/interfaces.js';
import { Page } from '../storage/Page.js';
import { makeRID, PageId } from '../common/types.js';

export class VecSeqScan implements IVecOperator {
  private ctx!: ExecContext;
  private chunk!: DataChunk;
  private currentPageId: number = 1;
  private currentSlotId: number = 0;
  private totalPages: number = 0;

  constructor(private plan: PhysSeqScan) {}

  async open(ctx: ExecContext): Promise<void> {
    this.ctx = ctx;
    const tableInfo = this.ctx.catalog.getTable(this.plan.tableId);
    if (!tableInfo) throw new Error(`VecSeqScan: Table not found ${this.plan.tableId}`);
    
    this.totalPages = tableInfo.heapFile.pageCount();
    this.chunk = new DataChunk(this.plan.schema);
    this.currentPageId = 1;
    this.currentSlotId = 0;
  }

  async nextBatch(): Promise<DataChunk | null> {
    this.chunk.reset();
    let rowsAdded = 0;

    while (this.currentPageId < this.totalPages && rowsAdded < BATCH_SIZE) {
      const pageId = this.currentPageId as PageId;
      const buf = await this.ctx.bufferPool.fetchPage(pageId);
      
      try {
        const page = new Page(buf);
        const numSlots = page.numSlots;

        const lockPromises: Promise<void>[] = [];

        while (this.currentSlotId < numSlots && rowsAdded < BATCH_SIZE) {
          const slotId = this.currentSlotId;
          const recordBuf = page.getRecord(slotId as any);
          this.currentSlotId++;

          if (recordBuf !== null) {
            const rid = makeRID(pageId, slotId);
            
            // Note: await is still required for strict 2PL, but avoiding Yield/Tuple allocation saves massive overhead
            lockPromises.push(this.ctx.lockManager.acquireRowLock(this.ctx.txn.txnId, rid, LockMode.S));

            this.decodeDirectlyToChunk(recordBuf, rowsAdded);
            rowsAdded++;
          }
        }
        
        if (lockPromises.length > 0) {
          await Promise.all(lockPromises);
        }

        if (this.currentSlotId >= numSlots) {
          this.currentPageId++;
          this.currentSlotId = 0;
        }

      } finally {
        this.ctx.bufferPool.unpinPage(pageId, false);
      }
    }

    if (rowsAdded === 0) return null;

    this.chunk.numRows = rowsAdded;
    return this.chunk;
  }

  private decodeDirectlyToChunk(buf: Buffer, rowIdx: number) {
    const schema = this.plan.schema;
    const nullBitmapLen = Math.ceil(schema.length / 8);
    let offset = nullBitmapLen;

    for (let i = 0; i < schema.length; i++) {
      const colDef = schema[i]!;
      const byteIdx = Math.floor(i / 8);
      const bitIdx = i % 8;
      const isNull = (buf[byteIdx]! & (1 << bitIdx)) !== 0;

      const colVec = this.chunk.columns[i]!;

      if (isNull) {
        colVec.nullMask[rowIdx] = 1;
        if (colVec.values instanceof VarcharBuffer) {
          colVec.values.append(rowIdx, Buffer.alloc(0));
        } else {
          (colVec.values as any)[rowIdx] = 0;
        }
        continue;
      }

      colVec.nullMask[rowIdx] = 0;

      switch (colDef.type) {
        case 'INT':
          (colVec.values as Int32Array)[rowIdx] = buf.readInt32LE(offset);
          offset += 4;
          break;
        case 'BIGINT':
          (colVec.values as BigInt64Array)[rowIdx] = buf.readBigInt64LE(offset);
          offset += 8;
          break;
        case 'FLOAT':
          (colVec.values as Float64Array)[rowIdx] = buf.readDoubleLE(offset);
          offset += 8;
          break;
        case 'BOOL':
          (colVec.values as Uint8Array)[rowIdx] = buf.readUInt8(offset) !== 0 ? 1 : 0;
          offset += 1;
          break;
        case 'VARCHAR':
          const len = buf.readUInt16LE(offset);
          offset += 2;
          // For VARCHAR, we can just pass the slice to append
          (colVec.values as VarcharBuffer).append(rowIdx, buf.subarray(offset, offset + len));
          offset += len;
          break;
      }
    }
  }

  async close(): Promise<void> {}
}
