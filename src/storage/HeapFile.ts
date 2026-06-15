// src/storage/HeapFile.ts — Phase 1
// Heap file: insert/delete/get/scan using buffer pool + slotted pages.

import type { IHeapFile } from '../common/interfaces.js';
import type { RID, Tuple, Schema } from '../common/types.js';

export class HeapFile implements IHeapFile {
  constructor(_tableId: string, _bufferPool: unknown, _diskManager: unknown) {
    throw new Error('HeapFile: not yet implemented — Phase 1');
  }
  insertTuple(_tuple: Tuple, _schema: Schema): Promise<RID> { throw new Error('NYI'); }
  deleteTuple(_rid: RID): Promise<void> { throw new Error('NYI'); }
  getTuple(_rid: RID, _schema: Schema): Promise<Tuple | null> { throw new Error('NYI'); }
  updateTuple(_rid: RID, _newTuple: Tuple, _schema: Schema): Promise<RID> { throw new Error('NYI'); }
  async *scan(_schema: Schema): AsyncIterableIterator<[RID, Tuple]> { throw new Error('NYI'); }
  pageCount(): number { throw new Error('NYI'); }
}
