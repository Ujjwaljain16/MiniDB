// src/index/BPlusTree.ts — Phase 2
// B+ tree index: all nodes are 4KB buffer pool pages.

import type { IBPlusTree } from '../common/interfaces.js';
import type { ColValue, RID, PageId } from '../common/types.js';
import { NULL_PAGE_ID } from '../common/types.js';

export class BPlusTree implements IBPlusTree {
  private _rootPageId: PageId = NULL_PAGE_ID;

  constructor(_bufferPool: unknown, _indexFile: string) {
    throw new Error('BPlusTree: not yet implemented — Phase 2');
  }
  search(_key: ColValue): Promise<RID | null> { throw new Error('NYI'); }
  async *searchRange(_low: ColValue, _high: ColValue): AsyncIterableIterator<RID> { throw new Error('NYI'); }
  insert(_key: ColValue, _rid: RID): Promise<void> { throw new Error('NYI'); }
  delete(_key: ColValue): Promise<void> { throw new Error('NYI'); }
  bulkLoad(_entries: ReadonlyArray<[ColValue, RID]>): Promise<void> { throw new Error('NYI'); }
  rootPageId(): PageId { return this._rootPageId; }
  height(): Promise<number> { throw new Error('NYI'); }
}
