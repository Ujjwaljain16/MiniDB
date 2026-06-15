import type { IHeapFile } from '../common/interfaces.js';
import type { Tuple, Schema, RID, PageId } from '../common/types.js';
import { makeRID, colByteSize } from '../common/types.js';
import { Page } from './Page.js';
import { BufferPool } from './BufferPool.js';
import { DiskManager } from './DiskManager.js';
import { FreeSpaceMap } from './FreeSpaceMap.js';

export function serializeTuple(tuple: Tuple, schema: Schema): Buffer {
  const nullBitmapLen = Math.ceil(schema.length / 8);
  let dataLen = nullBitmapLen;
  for (let i = 0; i < schema.length; i++) {
    const colDef = schema[i]!;
    const val = tuple[i];
    if (val !== null && val !== undefined) {
      dataLen += colByteSize(colDef, val);
    }
  }

  const buf = Buffer.alloc(dataLen);
  buf.fill(0, 0, nullBitmapLen); // Zero out null bitmap initially
  let offset = nullBitmapLen;

  for (let i = 0; i < schema.length; i++) {
    const colDef = schema[i]!;
    const val = tuple[i];
    
    if (val === null || val === undefined) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = i % 8;
      buf[byteIdx]! |= (1 << bitIdx); // set null bit
      continue;
    }

    switch (colDef.type) {
      case 'INT':
        buf.writeInt32LE(val as number, offset);
        offset += 4;
        break;
      case 'BIGINT':
        buf.writeBigInt64LE(BigInt(val as number | bigint), offset);
        offset += 8;
        break;
      case 'FLOAT':
        buf.writeDoubleLE(val as number, offset);
        offset += 8;
        break;
      case 'BOOL':
        buf.writeUInt8(val ? 1 : 0, offset);
        offset += 1;
        break;
      case 'VARCHAR':
        const str = String(val);
        const strBytes = Buffer.byteLength(str, 'utf8');
        buf.writeUInt16LE(strBytes, offset);
        offset += 2;
        buf.write(str, offset, strBytes, 'utf8');
        offset += strBytes;
        break;
    }
  }

  return buf;
}

export function deserializeTuple(buf: Buffer, schema: Schema): Tuple {
  const nullBitmapLen = Math.ceil(schema.length / 8);
  let offset = nullBitmapLen;
  const tuple: Tuple = [];

  for (let i = 0; i < schema.length; i++) {
    const colDef = schema[i]!;
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    const isNull = (buf[byteIdx]! & (1 << bitIdx)) !== 0;

    if (isNull) {
      tuple.push(null);
      continue;
    }

    switch (colDef.type) {
      case 'INT':
        tuple.push(buf.readInt32LE(offset));
        offset += 4;
        break;
      case 'BIGINT':
        // BigInt must be converted to standard JS number if it's safe, 
        // but ColValue allows bigint so we keep it as bigint.
        tuple.push(buf.readBigInt64LE(offset));
        offset += 8;
        break;
      case 'FLOAT':
        tuple.push(buf.readDoubleLE(offset));
        offset += 8;
        break;
      case 'BOOL':
        tuple.push(buf.readUInt8(offset) !== 0);
        offset += 1;
        break;
      case 'VARCHAR':
        const len = buf.readUInt16LE(offset);
        offset += 2;
        tuple.push(buf.toString('utf8', offset, offset + len));
        offset += len;
        break;
    }
  }

  return tuple;
}

export class HeapFile implements IHeapFile {
  private fsm: FreeSpaceMap;

  constructor(
    private tableId: string,
    private bufferPool: BufferPool,
    private diskManager: DiskManager
  ) {
    this.fsm = new FreeSpaceMap(this.bufferPool, 0 as PageId);
  }

  private async ensureFsmExists(): Promise<void> {
    if (this.diskManager.getPageCount() === 0) {
      const [pageId, buf] = await this.bufferPool.newPage();
      // Expect pageId to be 0 for FSM
      if (pageId !== 0) {
        this.bufferPool.unpinPage(pageId, false);
        throw new Error('FSM page ID must be 0');
      }
      const page = new Page(buf);
      page.init(0 as PageId, 3); // type 3 = meta
      this.bufferPool.unpinPage(0 as PageId, true);
    }
  }

  async insertTuple(tuple: Tuple, schema: Schema): Promise<RID> {
    await this.ensureFsmExists();

    const buf = serializeTuple(tuple, schema);
    const requiredBytes = buf.length;

    let targetPageId = await this.fsm.findFreePage(requiredBytes, this.pageCount());
    let pageBuf: Buffer;
    
    if (targetPageId !== null) {
      pageBuf = await this.bufferPool.fetchPage(targetPageId);
    } else {
      let newPId: PageId;
      [newPId, pageBuf] = await this.bufferPool.newPage();
      targetPageId = newPId;
      
      const page = new Page(pageBuf);
      page.init(targetPageId, 0); // type 0 = heap
    }

    const page = new Page(pageBuf);
    let slotId: number | null;
    try {
      slotId = page.insertRecord(buf);
      if (slotId === null) {
        throw new Error('HeapFile: Failed to insert record into allocated page');
      }
    } finally {
      this.bufferPool.unpinPage(targetPageId, true);
    }

    await this.fsm.updateFreeSpace(targetPageId, page.freeSpace());
    return makeRID(targetPageId, slotId);
  }

  async deleteTuple(rid: RID): Promise<void> {
    const buf = await this.bufferPool.fetchPage(rid.pageId);
    let freeSpace = 0;
    try {
      const page = new Page(buf);
      page.deleteRecord(rid.slotId);
      freeSpace = page.freeSpace();
    } finally {
      this.bufferPool.unpinPage(rid.pageId, true);
    }
    await this.fsm.updateFreeSpace(rid.pageId, freeSpace);
  }

  async getTuple(rid: RID, schema: Schema): Promise<Tuple | null> {
    const buf = await this.bufferPool.fetchPage(rid.pageId);
    try {
      const page = new Page(buf);
      const recordBuf = page.getRecord(rid.slotId);
      if (!recordBuf) return null;
      return deserializeTuple(recordBuf, schema);
    } finally {
      this.bufferPool.unpinPage(rid.pageId, false);
    }
  }

  async updateTuple(rid: RID, newTuple: Tuple, schema: Schema): Promise<RID> {
    await this.deleteTuple(rid);
    return await this.insertTuple(newTuple, schema);
  }

  async *scan(schema: Schema): AsyncIterableIterator<[RID, Tuple]> {
    const totalPages = this.pageCount();
    for (let pageId = 1; pageId < totalPages; pageId++) {
      const buf = await this.bufferPool.fetchPage(pageId as PageId);
      try {
        const page = new Page(buf);
        const numSlots = page.numSlots;
        for (let slotId = 0; slotId < numSlots; slotId++) {
          const recordBuf = page.getRecord(slotId as any);
          if (recordBuf !== null) {
            const tuple = deserializeTuple(recordBuf, schema);
            yield [makeRID(pageId, slotId), tuple];
          }
        }
      } finally {
        this.bufferPool.unpinPage(pageId as PageId, false);
      }
    }
  }

  pageCount(): number {
    return this.diskManager.getPageCount();
  }
}
