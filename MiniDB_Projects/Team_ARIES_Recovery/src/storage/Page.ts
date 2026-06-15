import type { PageId, SlotId, LSN } from '../common/types.js';
import { PAGE_SIZE, PAGE_HEADER_SIZE, SLOT_ENTRY_SIZE, SLOT_TOMBSTONE } from '../common/config.js';

export class Page {
  private static readonly OFFSET_PAGE_ID = 0;
  private static readonly OFFSET_NUM_SLOTS = 4;
  private static readonly OFFSET_FREE_SPACE = 6;
  private static readonly OFFSET_PAGE_LSN = 8;
  private static readonly OFFSET_PAGE_TYPE = 16;

  private buf: Buffer;

  constructor(buf: Buffer) {
    if (buf.length !== PAGE_SIZE) {
      throw new Error(`Page buffer must be exactly ${PAGE_SIZE} bytes`);
    }
    this.buf = buf;
  }

  get buffer(): Buffer {
    return this.buf;
  }

  get pageId(): PageId {
    return this.buf.readUInt32LE(Page.OFFSET_PAGE_ID) as PageId;
  }
  set pageId(id: PageId) {
    this.buf.writeUInt32LE(id, Page.OFFSET_PAGE_ID);
  }

  get numSlots(): number {
    return this.buf.readUInt16LE(Page.OFFSET_NUM_SLOTS);
  }
  set numSlots(n: number) {
    this.buf.writeUInt16LE(n, Page.OFFSET_NUM_SLOTS);
  }

  get freeSpacePtr(): number {
    return this.buf.readUInt16LE(Page.OFFSET_FREE_SPACE);
  }
  set freeSpacePtr(ptr: number) {
    this.buf.writeUInt16LE(ptr, Page.OFFSET_FREE_SPACE);
  }

  get pageLsn(): LSN {
    return Number(this.buf.readBigInt64LE(Page.OFFSET_PAGE_LSN)) as LSN;
  }
  set pageLsn(lsn: LSN) {
    this.buf.writeBigInt64LE(BigInt(lsn), Page.OFFSET_PAGE_LSN);
  }

  get pageType(): number {
    return this.buf.readUInt8(Page.OFFSET_PAGE_TYPE);
  }
  set pageType(type: number) {
    this.buf.writeUInt8(type, Page.OFFSET_PAGE_TYPE);
  }

  /** Initialize a new page by setting initial header values */
  init(pageId: PageId, pageType: number = 0): void {
    this.buf.fill(0);
    this.pageId = pageId;
    this.numSlots = 0;
    this.freeSpacePtr = PAGE_SIZE;
    this.pageLsn = 0 as LSN;
    this.pageType = pageType;
  }

  freeSpace(): number {
    return this.freeSpacePtr - (PAGE_HEADER_SIZE + this.numSlots * SLOT_ENTRY_SIZE);
  }

  insertRecord(data: Buffer): SlotId | null {
    let targetSlot = -1;
    const nSlots = this.numSlots;
    const requiredSpace = data.length;

    // Try to find a tombstone slot first
    for (let i = 0; i < nSlots; i++) {
      const slotOffset = PAGE_HEADER_SIZE + i * SLOT_ENTRY_SIZE;
      const dataOffset = this.buf.readUInt16LE(slotOffset);
      if (dataOffset === SLOT_TOMBSTONE) {
        // We can reuse this slot. We just need space for the data.
        const spaceForData = this.freeSpacePtr - (PAGE_HEADER_SIZE + nSlots * SLOT_ENTRY_SIZE);
        if (spaceForData >= requiredSpace) {
          targetSlot = i;
          break;
        }
      }
    }

    if (targetSlot === -1) {
      // Need a new slot
      if (this.freeSpace() < requiredSpace + SLOT_ENTRY_SIZE) {
        return null;
      }
      targetSlot = nSlots;
      this.numSlots = nSlots + 1;
    }

    // Write data at the new freeSpacePtr
    this.freeSpacePtr -= data.length;
    data.copy(this.buf, this.freeSpacePtr);

    // Update the slot directory entry
    const slotOffset = PAGE_HEADER_SIZE + targetSlot * SLOT_ENTRY_SIZE;
    this.buf.writeUInt16LE(this.freeSpacePtr, slotOffset); // offset
    this.buf.writeUInt16LE(data.length, slotOffset + 2); // length

    return targetSlot as SlotId;
  }

  /** Used by Crash Recovery (Redo) to repeat history exactly. */
  forceInsertRecord(slotId: SlotId, data: Buffer): void {
    if (slotId >= this.numSlots) {
      this.numSlots = slotId + 1;
    }

    this.freeSpacePtr -= data.length;
    data.copy(this.buf, this.freeSpacePtr);

    const slotOffset = PAGE_HEADER_SIZE + slotId * SLOT_ENTRY_SIZE;
    this.buf.writeUInt16LE(this.freeSpacePtr, slotOffset);
    this.buf.writeUInt16LE(data.length, slotOffset + 2);
  }

  deleteRecord(slotId: SlotId): void {
    if (slotId >= this.numSlots) return;
    const slotOffset = PAGE_HEADER_SIZE + slotId * SLOT_ENTRY_SIZE;
    this.buf.writeUInt16LE(SLOT_TOMBSTONE, slotOffset);
  }

  getRecord(slotId: SlotId): Buffer | null {
    if (slotId >= this.numSlots) return null;
    const slotOffset = PAGE_HEADER_SIZE + slotId * SLOT_ENTRY_SIZE;
    const dataOffset = this.buf.readUInt16LE(slotOffset);
    if (dataOffset === SLOT_TOMBSTONE) return null;

    const dataLen = this.buf.readUInt16LE(slotOffset + 2);
    const data = Buffer.alloc(dataLen);
    this.buf.copy(data, 0, dataOffset, dataOffset + dataLen);
    return data;
  }

  compact(): void {
    const nSlots = this.numSlots;
    let newNumSlots = nSlots;
    
    // Trim trailing tombstones to reclaim slot directory space
    for (let i = nSlots - 1; i >= 0; i--) {
      const slotOffset = PAGE_HEADER_SIZE + i * SLOT_ENTRY_SIZE;
      if (this.buf.readUInt16LE(slotOffset) !== SLOT_TOMBSTONE) {
        break;
      }
      newNumSlots--;
    }

    const tempBuf = Buffer.alloc(PAGE_SIZE);
    // Copy the header and the active slot directory
    this.buf.copy(tempBuf, 0, 0, PAGE_HEADER_SIZE + newNumSlots * SLOT_ENTRY_SIZE);
    
    let currentDataOffset = PAGE_SIZE;

    for (let i = 0; i < newNumSlots; i++) {
      const slotOffset = PAGE_HEADER_SIZE + i * SLOT_ENTRY_SIZE;
      const dataOffset = this.buf.readUInt16LE(slotOffset);
      
      if (dataOffset !== SLOT_TOMBSTONE) {
        const dataLen = this.buf.readUInt16LE(slotOffset + 2);
        currentDataOffset -= dataLen;
        
        this.buf.copy(tempBuf, currentDataOffset, dataOffset, dataOffset + dataLen);
        tempBuf.writeUInt16LE(currentDataOffset, slotOffset);
      }
    }
    
    tempBuf.writeUInt16LE(newNumSlots, 4); // update numSlots
    tempBuf.writeUInt16LE(currentDataOffset, 6); // update freeSpacePtr
    tempBuf.copy(this.buf, 0, 0, PAGE_SIZE);
  }
}
