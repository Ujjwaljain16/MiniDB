import { FreeSpaceMap } from '../../../src/storage/FreeSpaceMap';
import type { IBufferPool, BufferPoolStats } from '../../../src/common/interfaces';
import type { PageId, LSN } from '../../../src/common/types';
import { PAGE_SIZE } from '../../../src/common/config';

class MockBufferPool implements IBufferPool {
  getDirtyPageTable() { return new Map(); }
  private pages = new Map<PageId, Buffer>();

  async fetchPage(pageId: PageId): Promise<Buffer> {
    if (!this.pages.has(pageId)) {
      this.pages.set(pageId, Buffer.alloc(PAGE_SIZE));
    }
    return this.pages.get(pageId)!;
  }
  async newPage(): Promise<[PageId, Buffer]> { return [0 as PageId, Buffer.alloc(0)]; }
  unpinPage(pageId: PageId, isDirty: boolean): void {}
  async flushPage(pageId: PageId): Promise<void> {}
  async flushAll(): Promise<void> {}
  setPageLsn(pageId: PageId, lsn: LSN): void {}
  stats(): BufferPoolStats { return {} as any; }
}

describe('FreeSpaceMap', () => {
  let bp: MockBufferPool;
  let fsm: FreeSpaceMap;

  beforeEach(() => {
    bp = new MockBufferPool();
    fsm = new FreeSpaceMap(bp, 0 as PageId);
  });

  it('updates free space and finds free pages', async () => {
    // We have 3 pages in total. page 0 is FSM. page 1 and 2 are data.
    await fsm.updateFreeSpace(1 as PageId, 100); // 100 bytes free on page 1 (val: 6)
    await fsm.updateFreeSpace(2 as PageId, 300); // 300 bytes free on page 2 (val: 18)

    // Find page with at least 80 bytes needed
    const p1 = await fsm.findFreePage(80, 3);
    expect(p1).toBe(1);

    // Find page with at least 200 bytes needed (page 1 can't fit it)
    const p2 = await fsm.findFreePage(200, 3);
    expect(p2).toBe(2);

    // Find page with at least 400 bytes needed (none can fit it)
    const p3 = await fsm.findFreePage(400, 3);
    expect(p3).toBeNull();
  });

  it('does not track FSM page itself', async () => {
    await fsm.updateFreeSpace(0 as PageId, 4000);
    const p = await fsm.findFreePage(100, 1);
    expect(p).toBeNull(); // page 0 is not returned
  });
});
