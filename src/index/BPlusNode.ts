import type { PageId, RID, ColValue, ColumnDef } from '../common/types.js';
import { NULL_PAGE_ID, encodeRID, decodeRID } from '../common/types.js';
import { PAGE_SIZE } from '../common/config.js';
import { getKeySize, writeKey, readKey, compareKeys } from './BPlusKeyUtils.js';

export const BPLUS_HEADER_SIZE = 24;

export class BPlusNode {
  public keySize: number;

  constructor(private buf: Buffer, private colDef: ColumnDef) {
    this.keySize = getKeySize(colDef);
  }

  // Header accessors
  get pageId(): PageId { return this.buf.readInt32LE(0) as PageId; }
  set pageId(val: PageId) { this.buf.writeInt32LE(val, 0); }

  get isLeaf(): boolean { return this.buf.readUInt8(4) === 2; }
  set isLeaf(val: boolean) { this.buf.writeUInt8(val ? 2 : 1, 4); }

  get numKeys(): number { return this.buf.readUInt16LE(5); }
  set numKeys(val: number) { this.buf.writeUInt16LE(val, 5); }

  get parentPageId(): PageId { return this.buf.readInt32LE(7) as PageId; }
  set parentPageId(val: PageId) { this.buf.writeInt32LE(val, 7); }

  get nextLeafId(): PageId { return this.buf.readInt32LE(11) as PageId; }
  set nextLeafId(val: PageId) { this.buf.writeInt32LE(val, 11); }

  init(pageId: PageId, isLeaf: boolean, parentId: PageId = NULL_PAGE_ID) {
    this.pageId = pageId;
    this.isLeaf = isLeaf;
    this.numKeys = 0;
    this.parentPageId = parentId;
    this.nextLeafId = NULL_PAGE_ID;
  }

  // Capacity calculations
  get maxLeafEntries(): number {
    return Math.floor((PAGE_SIZE - BPLUS_HEADER_SIZE) / (this.keySize + 6));
  }

  get maxInternalKeys(): number {
    return Math.floor((PAGE_SIZE - BPLUS_HEADER_SIZE - 4) / (this.keySize + 4));
  }

  get maxKeys(): number {
    return this.isLeaf ? this.maxLeafEntries : this.maxInternalKeys;
  }

  // --- LEAF NODE METHODS ---

  getLeafEntry(index: number): { key: ColValue, rid: RID } {
    const offset = BPLUS_HEADER_SIZE + index * (this.keySize + 6);
    const key = readKey(this.buf, offset, this.colDef);
    const rid = decodeRID(this.buf, offset + this.keySize);
    return { key, rid };
  }

  setLeafEntry(index: number, key: ColValue, rid: RID) {
    const offset = BPLUS_HEADER_SIZE + index * (this.keySize + 6);
    writeKey(this.buf, offset, key, this.colDef);
    encodeRID(rid, this.buf, offset + this.keySize);
  }

  insertLeafEntry(key: ColValue, rid: RID): void {
    const n = this.numKeys;
    let insertIdx = 0;
    
    // Find index to insert
    while (insertIdx < n) {
      const curKey = this.getLeafEntry(insertIdx).key;
      if (compareKeys(key, curKey, this.colDef) < 0) {
        break;
      }
      insertIdx++;
    }

    // Shift right
    const entrySize = this.keySize + 6;
    const offset = BPLUS_HEADER_SIZE + insertIdx * entrySize;
    if (insertIdx < n) {
      this.buf.copy(this.buf, offset + entrySize, offset, BPLUS_HEADER_SIZE + n * entrySize);
    }
    
    // Insert
    this.setLeafEntry(insertIdx, key, rid);
    this.numKeys = n + 1;
  }

  deleteLeafEntry(key: ColValue): boolean {
    const n = this.numKeys;
    let delIdx = -1;
    for (let i = 0; i < n; i++) {
      if (compareKeys(key, this.getLeafEntry(i).key, this.colDef) === 0) {
        delIdx = i;
        break;
      }
    }
    
    if (delIdx === -1) return false;

    const entrySize = this.keySize + 6;
    const offset = BPLUS_HEADER_SIZE + delIdx * entrySize;
    if (delIdx < n - 1) {
      this.buf.copy(this.buf, offset, offset + entrySize, BPLUS_HEADER_SIZE + n * entrySize);
    }
    this.numKeys = n - 1;
    return true;
  }

  binarySearch(key: ColValue): RID | null {
    let left = 0;
    let right = this.numKeys - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const { key: midKey, rid: midRid } = this.getLeafEntry(mid);
      const cmp = compareKeys(key, midKey, this.colDef);

      if (cmp === 0) return midRid;
      if (cmp < 0) right = mid - 1;
      else left = mid + 1;
    }
    return null;
  }

  // --- INTERNAL NODE METHODS ---

  getInternalKey(index: number): ColValue {
    const offset = BPLUS_HEADER_SIZE + index * this.keySize;
    return readKey(this.buf, offset, this.colDef);
  }

  setInternalKey(index: number, key: ColValue) {
    const offset = BPLUS_HEADER_SIZE + index * this.keySize;
    writeKey(this.buf, offset, key, this.colDef);
  }

  getChildId(index: number): PageId {
    const maxK = this.maxInternalKeys;
    // children start after all possible keys to keep the layout simple, 
    // OR they start after the current keys.
    // The spec says:
    // [24] keys[] (num_keys * key_size bytes)
    // [24 + num_keys * key_size] children[] (num_keys+1 * 4 bytes)
    // Actually, shifting children array every time a key is inserted is VERY inefficient.
    // Standard practice: store keys array and children array at fixed offsets or shift both.
    // To match the spec strictly and still be efficient, we can allocate fixed space for keys.
    // Let's use fixed offset: children array starts at BPLUS_HEADER_SIZE + maxInternalKeys * keySize.
    const offset = BPLUS_HEADER_SIZE + maxK * this.keySize + index * 4;
    return this.buf.readInt32LE(offset) as PageId;
  }

  setChildId(index: number, pageId: PageId) {
    const maxK = this.maxInternalKeys;
    const offset = BPLUS_HEADER_SIZE + maxK * this.keySize + index * 4;
    this.buf.writeInt32LE(pageId, offset);
  }

  findChildIndex(key: ColValue): number {
    const n = this.numKeys;
    let left = 0;
    let right = n - 1;
    let result = n; // default to rightmost child
    
    // We want the first index i where key < K_i
    // If key < K_0, return 0.
    // If key >= K_n-1, return n.
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midKey = this.getInternalKey(mid);
      const cmp = compareKeys(key, midKey, this.colDef);
      
      if (cmp < 0) {
        result = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    
    return result;
  }

  insertInternalEntry(key: ColValue, childId: PageId): void {
    const n = this.numKeys;
    let insertIdx = 0;
    
    while (insertIdx < n) {
      if (compareKeys(key, this.getInternalKey(insertIdx), this.colDef) < 0) break;
      insertIdx++;
    }

    // Shift keys right
    for (let i = n; i > insertIdx; i--) {
      this.setInternalKey(i, this.getInternalKey(i - 1));
    }
    // Shift children right
    for (let i = n + 1; i > insertIdx + 1; i--) {
      this.setChildId(i, this.getChildId(i - 1));
    }

    this.setInternalKey(insertIdx, key);
    this.setChildId(insertIdx + 1, childId);
    this.numKeys = n + 1;
  }

  deleteInternalEntry(index: number): void {
    const n = this.numKeys;
    // shift keys
    for (let i = index; i < n - 1; i++) {
      this.setInternalKey(i, this.getInternalKey(i + 1));
    }
    // shift children
    for (let i = index + 1; i < n; i++) {
      this.setChildId(i, this.getChildId(i + 1));
    }
    this.numKeys = n - 1;
  }
}
