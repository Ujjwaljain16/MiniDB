import type { IBufferPool, BufferPoolStats, ILogManager, IDiskManager, PageKind, PageEvent } from '../common/interfaces.js';
import type { PageId, LSN } from '../common/types.js';
import { INVALID_LSN } from '../common/types.js';
import { PAGE_SIZE } from '../common/config.js';
import { Page } from './Page.js';

export type { PageKind, PageEvent } from '../common/interfaces.js';

const KIND_BY_TYPE: readonly PageKind[] = ['heap', 'btree-leaf', 'btree-internal', 'fsm'];

function pageKind(pageId: PageId, buf: Buffer): PageKind {
  if (pageId === 0) return 'fsm';
  return KIND_BY_TYPE[buf[16]!] ?? 'unknown';
}

interface Frame {
  pageId:     PageId;
  buffer:     Buffer;
  pinCount:   number;
  isDirty:    boolean;
  pageLsn:    LSN;
  recLsn:     LSN;
  accessHistory: number[]; // stores up to K timestamps
}

export class BufferPool implements IBufferPool {
  private frames: Frame[];
  private pageTable: Map<PageId, number>; // pageId -> frame index
  private currentTimestamp: number = 0;
  public K: number = 2;
  public onPageEvent: ((e: PageEvent) => void) | null = null;

  private statsCounters: BufferPoolStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    dirtyPages: 0,
    pinnedPages: 0,
    hitRatio: 0,
  };

  constructor(
    private diskManager: IDiskManager,
    private logManager: ILogManager,
    private poolSize: number = 64
  ) {
    this.frames = new Array(poolSize);
    for (let i = 0; i < poolSize; i++) {
      this.frames[i] = {
        pageId: -1 as PageId,
        buffer: Buffer.alloc(PAGE_SIZE),
        pinCount: 0,
        isDirty: false,
        pageLsn: INVALID_LSN,
        recLsn: INVALID_LSN,
        accessHistory: [],
      };
    }
    this.pageTable = new Map();
  }

  private updateHistory(frameIndex: number): void {
    const frame = this.frames[frameIndex]!;
    frame.accessHistory.push(++this.currentTimestamp);
    if (frame.accessHistory.length > this.K) {
      frame.accessHistory.shift(); // Keep only the last K accesses
    }
  }

  private getKthAccessTime(frame: Frame): number {
    if (frame.accessHistory.length < this.K) {
      return -Infinity;
    }
    return frame.accessHistory[0]!;
  }

  private selectVictim(): number {
    let victimIndex = -1;
    let minKthAccess = Infinity;
    let minFirstAccess = Infinity;

    for (let i = 0; i < this.poolSize; i++) {
      const frame = this.frames[i]!;
      if (frame.pinCount > 0) continue; // Skip pinned frames

      // Empty frames are perfect victims
      if (frame.pageId === -1) {
        return i;
      }

      const kthAccess = this.getKthAccessTime(frame);
      if (kthAccess === -Infinity) {
        // Less than K accesses: use FIFO on the first access time
        const firstAccess = frame.accessHistory.length > 0 ? frame.accessHistory[0]! : -Infinity;
        if (minKthAccess !== -Infinity || firstAccess < minFirstAccess) {
          minKthAccess = -Infinity;
          minFirstAccess = firstAccess;
          victimIndex = i;
        }
      } else if (minKthAccess !== -Infinity && kthAccess < minKthAccess) {
        // K or more accesses: use standard LRU based on the Kth access
        minKthAccess = kthAccess;
        victimIndex = i;
      }
    }

    if (victimIndex === -1) {
      throw new Error('BufferPool: all frames are pinned, cannot evict');
    }

    return victimIndex;
  }

  /** Pick a frame to reuse, writing back and dropping the page it holds. */
  private async evictVictim(): Promise<number> {
    const fi = this.selectVictim();
    const victim = this.frames[fi]!;

    if (victim.pageId !== -1) {
      this.statsCounters.evictions++;
      if (this.onPageEvent !== null) {
        this.onPageEvent({ type: 'evict', pageId: victim.pageId, frame: fi, kind: pageKind(victim.pageId, victim.buffer), dirty: victim.isDirty });
      }
      if (victim.isDirty) {
        // WAL Rule: flush log up to victim's page LSN before evicting
        if (victim.pageLsn !== INVALID_LSN) {
          await this.logManager.flush(victim.pageLsn);
        }
        await this.diskManager.writePage(victim.pageId, victim.buffer);
        if (this.onPageEvent !== null) {
          this.onPageEvent({ type: 'flush', pageId: victim.pageId, frame: fi, kind: pageKind(victim.pageId, victim.buffer) });
        }
      }
      this.pageTable.delete(victim.pageId);
    }
    return fi;
  }

  async fetchPage(pageId: PageId): Promise<Buffer> {
    if (this.pageTable.has(pageId)) {
      this.statsCounters.hits++;
      const fi = this.pageTable.get(pageId)!;
      this.frames[fi]!.pinCount++;
      this.updateHistory(fi);
      if (this.onPageEvent !== null) {
        this.onPageEvent({ type: 'hit', pageId, frame: fi, kind: pageKind(pageId, this.frames[fi]!.buffer) });
      }
      return this.frames[fi]!.buffer;
    }

    this.statsCounters.misses++;
    const fi = await this.evictVictim();
    const victim = this.frames[fi]!;

    await this.diskManager.readPage(pageId, victim.buffer);
    victim.pageId = pageId;
    victim.pinCount = 1;
    victim.isDirty = false;
    victim.pageLsn = INVALID_LSN;
    victim.recLsn = INVALID_LSN;
    victim.accessHistory = [];
    this.pageTable.set(pageId, fi);
    this.updateHistory(fi);
    if (this.onPageEvent !== null) {
      this.onPageEvent({ type: 'miss', pageId, frame: fi, kind: pageKind(pageId, victim.buffer) });
    }

    return victim.buffer;
  }

  async newPage(): Promise<[PageId, Buffer]> {
    const fi = await this.evictVictim();
    const victim = this.frames[fi]!;

    const pageId = await this.diskManager.allocatePage();
    // buffer is already zeroed by allocatePage, but we zero our in-memory buffer too
    victim.buffer.fill(0);
    victim.pageId = pageId;
    victim.pinCount = 1;
    victim.isDirty = false;
    victim.pageLsn = INVALID_LSN;
    victim.recLsn = INVALID_LSN;
    victim.accessHistory = [];
    this.pageTable.set(pageId, fi);
    this.updateHistory(fi);
    if (this.onPageEvent !== null) {
      this.onPageEvent({ type: 'new', pageId, frame: fi, kind: 'unknown' });
    }

    return [pageId, victim.buffer];
  }

  unpinPage(pageId: PageId, isDirty: boolean): void {
    const fi = this.pageTable.get(pageId);
    if (fi === undefined) return;
    const frame = this.frames[fi]!;
    if (frame.pinCount <= 0) {
      throw new Error(`BufferPool: page ${pageId} pin count is already 0`);
    }
    frame.pinCount--;
    if (isDirty) {
      frame.isDirty = true;
    }
  }

  async flushPage(pageId: PageId): Promise<void> {
    const fi = this.pageTable.get(pageId);
    if (fi === undefined) return;
    const frame = this.frames[fi]!;
    if (frame.isDirty) {
      if (frame.pageLsn !== INVALID_LSN) {
        await this.logManager.flush(frame.pageLsn);
      }
      await this.diskManager.writePage(frame.pageId, frame.buffer);
      frame.isDirty = false;
      frame.recLsn = INVALID_LSN;
      if (this.onPageEvent !== null) {
        this.onPageEvent({ type: 'flush', pageId, frame: fi, kind: pageKind(pageId, frame.buffer) });
      }
    }
  }

  async flushAll(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      const frame = this.frames[i]!;
      if (frame.pageId !== -1 && frame.isDirty) {
        if (frame.pageLsn !== INVALID_LSN) {
          await this.logManager.flush(frame.pageLsn);
        }
        await this.diskManager.writePage(frame.pageId, frame.buffer);
        frame.isDirty = false;
        frame.recLsn = INVALID_LSN;
        if (this.onPageEvent !== null) {
          this.onPageEvent({ type: 'flush', pageId: frame.pageId, frame: i, kind: pageKind(frame.pageId, frame.buffer) });
        }
      }
    }
  }

  setPageLsn(pageId: PageId, lsn: LSN): void {
    const fi = this.pageTable.get(pageId);
    if (fi !== undefined) {
      const frame = this.frames[fi]!;
      frame.pageLsn = lsn;
      if (frame.recLsn === INVALID_LSN) {
        frame.recLsn = lsn;
      }
      const page = new Page(frame.buffer);
      page.pageLsn = lsn;
    }
  }

  stats(): BufferPoolStats {
    let pinned = 0;
    let dirty = 0;
    for (let i = 0; i < this.poolSize; i++) {
      if (this.frames[i]!.pageId !== -1) {
        if (this.frames[i]!.pinCount > 0) pinned++;
        if (this.frames[i]!.isDirty) dirty++;
      }
    }
    this.statsCounters.pinnedPages = pinned;
    this.statsCounters.dirtyPages = dirty;
    const totalRequests = this.statsCounters.hits + this.statsCounters.misses;
    this.statsCounters.hitRatio = totalRequests > 0 ? this.statsCounters.hits / totalRequests : 0;
    return { ...this.statsCounters };
  }

  /** Every frame's current contents, empty frames included (pageId -1). */
  snapshot(): Array<{ frame: number; pageId: number; pinCount: number; dirty: boolean; kind: PageKind }> {
    return this.frames.map((f, frame) => ({
      frame,
      pageId: f.pageId,
      pinCount: f.pinCount,
      dirty: f.isDirty,
      kind: f.pageId === -1 ? 'unknown' : pageKind(f.pageId, f.buffer),
    }));
  }

  getDirtyPageTable(): Map<PageId, LSN> {
    const dpt = new Map<PageId, LSN>();
    for (let i = 0; i < this.poolSize; i++) {
      const frame = this.frames[i]!;
      if (frame.pageId !== -1 && frame.isDirty && frame.recLsn !== INVALID_LSN) {
        dpt.set(frame.pageId, frame.recLsn);
      }
    }
    return dpt;
  }
}
