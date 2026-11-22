import type { PageId } from '../common/types.js';
import type { IDiskManager } from '../common/interfaces.js';
import { PAGE_SIZE } from '../common/config.js';

/** Keeps every page in memory. Bytes are always copied, never shared with the caller. */
export class MemDiskManager implements IDiskManager {
  private pages: Buffer[] = [];

  async readPage(pageId: PageId, buf: Buffer): Promise<void> {
    const src = this.pages[pageId];
    if (src) {
      src.copy(buf, 0, 0, PAGE_SIZE);
    } else {
      buf.fill(0, 0, PAGE_SIZE);
    }
  }

  async writePage(pageId: PageId, buf: Buffer): Promise<void> {
    while (this.pages.length <= pageId) {
      this.pages.push(Buffer.alloc(PAGE_SIZE));
    }
    buf.copy(this.pages[pageId]!, 0, 0, PAGE_SIZE);
  }

  async allocatePage(): Promise<PageId> {
    this.pages.push(Buffer.alloc(PAGE_SIZE));
    return (this.pages.length - 1) as PageId;
  }

  getPageCount(): number {
    return this.pages.length;
  }

  async close(): Promise<void> {}
}
