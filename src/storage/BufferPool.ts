import type { IBufferPool, BufferPoolStats, ILogManager } from '../common/interfaces.js';
import type { PageId, LSN } from '../common/types.js';
import { INVALID_LSN } from '../common/types.js';
import { PAGE_SIZE } from '../common/config.js';
import { DiskManager } from './DiskManager.js';

interface Frame {
  pageId:     PageId;
  buffer:     Buffer;
  pinCount:   number;
  isDirty:    boolean;
  pageLsn:    LSN;
  accessHistory: number[]; // stores up to K timestamps
}

export class BufferPool implements IBufferPool {
  private frames: Frame[];
  private pageTable: Map<PageId, number>; // pageId -> frame index
  private currentTimestamp: number = 0;
  private readonly K = 2;

  private statsCounters: BufferPoolStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    dirtyPages: 0,
    pinnedPages: 0,
    hitRatio: 0,
  };

  constructor(
    private diskManager: DiskManager,
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

  async fetchPage(pageId: PageId): Promise<Buffer> {
    if (this.pageTable.has(pageId)) {
      this.statsCounters.hits++;
      const fi = this.pageTable.get(pageId)!;
      this.frames[fi]!.pinCount++;
      this.updateHistory(fi);
      return this.frames[fi]!.buffer;
    }

    this.statsCounters.misses++;
    const fi = this.selectVictim();
    const victim = this.frames[fi]!;

    if (victim.pageId !== -1) {
      this.statsCounters.evictions++;
      if (victim.isDirty) {
        // WAL Rule: flush log up to victim's page LSN before evicting
        if (victim.pageLsn !== INVALID_LSN) {
          await this.logManager.flush(victim.pageLsn);
        }
        await this.diskManager.writePage(victim.pageId, victim.buffer);
      }
      this.pageTable.delete(victim.pageId);
    }

    await this.diskManager.readPage(pageId, victim.buffer);
    victim.pageId = pageId;
    victim.pinCount = 1;
    victim.isDirty = false;
    victim.pageLsn = INVALID_LSN;
    victim.accessHistory = [];
    this.pageTable.set(pageId, fi);
    this.updateHistory(fi);

    return victim.buffer;
  }

  async newPage(): Promise<[PageId, Buffer]> {
    const fi = this.selectVictim();
    const victim = this.frames[fi]!;

    if (victim.pageId !== -1) {
      this.statsCounters.evictions++;
      if (victim.isDirty) {
        if (victim.pageLsn !== INVALID_LSN) {
          await this.logManager.flush(victim.pageLsn);
        }
        await this.diskManager.writePage(victim.pageId, victim.buffer);
      }
      this.pageTable.delete(victim.pageId);
    }

    const pageId = await this.diskManager.allocatePage();
    // buffer is already zeroed by allocatePage, but we zero our in-memory buffer too
    victim.buffer.fill(0);
    victim.pageId = pageId;
    victim.pinCount = 1;
    victim.isDirty = false;
    victim.pageLsn = INVALID_LSN;
    victim.accessHistory = [];
    this.pageTable.set(pageId, fi);
    this.updateHistory(fi);

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
      }
    }
  }

  setPageLsn(pageId: PageId, lsn: LSN): void {
    const fi = this.pageTable.get(pageId);
    if (fi !== undefined) {
      this.frames[fi]!.pageLsn = lsn;
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
}
