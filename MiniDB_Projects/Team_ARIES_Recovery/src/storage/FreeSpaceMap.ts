import type { IBufferPool } from '../common/interfaces.js';
import type { PageId } from '../common/types.js';
import { PAGE_SIZE, PAGE_HEADER_SIZE } from '../common/config.js';

export class FreeSpaceMap {
  constructor(private bufferPool: IBufferPool, private fsmPageId: PageId = 0 as PageId) {}

  /**
   * Update the FSM entry for a specific page.
   * Granularity is 16 bytes per unit. Max value is 255.
   */
  async updateFreeSpace(pageId: PageId, freeBytes: number): Promise<void> {
    if (pageId <= this.fsmPageId) return; // Do not track FSM page itself
    const fsmIndex = pageId - this.fsmPageId - 1;
    
    // We only support a single-page FSM for now, tracking up to 4072 pages
    const maxTracked = PAGE_SIZE - PAGE_HEADER_SIZE;
    if (fsmIndex >= maxTracked) return;

    const buf = await this.bufferPool.fetchPage(this.fsmPageId);
    try {
      const fsmValue = Math.min(255, Math.floor(freeBytes / 16));
      buf.writeUInt8(fsmValue, PAGE_HEADER_SIZE + fsmIndex);
    } finally {
      this.bufferPool.unpinPage(this.fsmPageId, true); // Mark FSM page as dirty
    }
  }

  /**
   * Find a page that has at least `requiredBytes` of free space.
   * `totalPages` is the current size of the heap file in pages.
   */
  async findFreePage(requiredBytes: number, totalPages: number): Promise<PageId | null> {
    const requiredFsmValue = Math.ceil(requiredBytes / 16);
    if (requiredFsmValue > 255) return null;

    const buf = await this.bufferPool.fetchPage(this.fsmPageId);
    try {
      const numTracked = Math.min(totalPages - 1, PAGE_SIZE - PAGE_HEADER_SIZE);
      for (let i = 0; i < numTracked; i++) {
        const val = buf.readUInt8(PAGE_HEADER_SIZE + i);
        if (val >= requiredFsmValue) {
          return (this.fsmPageId + 1 + i) as PageId;
        }
      }
      return null;
    } finally {
      this.bufferPool.unpinPage(this.fsmPageId, false);
    }
  }
}
