// src/storage/BufferPool.ts — Phase 1
// LRU-K (K=2) buffer pool: 64 frames, pin/unpin, WAL-rule enforcement.

import type { IBufferPool, BufferPoolStats } from '../common/interfaces.js';
import type { PageId, LSN } from '../common/types.js';

export class BufferPool implements IBufferPool {
  constructor(_diskManager: unknown, _logManager: unknown, _poolSize?: number) {
    throw new Error('BufferPool: not yet implemented — Phase 1');
  }
  fetchPage(_pageId: PageId): Promise<Buffer> { throw new Error('NYI'); }
  newPage(): Promise<[PageId, Buffer]> { throw new Error('NYI'); }
  unpinPage(_pageId: PageId, _isDirty: boolean): void { throw new Error('NYI'); }
  flushPage(_pageId: PageId): Promise<void> { throw new Error('NYI'); }
  flushAll(): Promise<void> { throw new Error('NYI'); }
  setPageLsn(_pageId: PageId, _lsn: LSN): void { throw new Error('NYI'); }
  stats(): BufferPoolStats { throw new Error('NYI'); }
}
