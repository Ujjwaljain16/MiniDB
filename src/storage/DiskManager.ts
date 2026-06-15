import * as fs from 'fs/promises';
import { constants } from 'fs';
import type { PageId } from '../common/types.js';
import { PAGE_SIZE } from '../common/config.js';

export class DiskManager {
  private fd: fs.FileHandle;
  private numPages: number;

  private constructor(fd: fs.FileHandle, numPages: number) {
    this.fd = fd;
    this.numPages = numPages;
  }

  static async open(filePath: string): Promise<DiskManager> {
    // Open for read/write, create if not exists
    const fd = await fs.open(filePath, constants.O_RDWR | constants.O_CREAT);
    const { size } = await fd.stat();
    return new DiskManager(fd, Math.floor(size / PAGE_SIZE));
  }

  async readPage(pageId: PageId, buf: Buffer): Promise<void> {
    const offset = pageId * PAGE_SIZE;
    const { bytesRead } = await this.fd.read(buf, 0, PAGE_SIZE, offset);
    if (bytesRead < PAGE_SIZE) {
      // If we read less than a full page (e.g. newly created file not fully padded),
      // zero out the remaining bytes in the buffer.
      buf.fill(0, bytesRead, PAGE_SIZE);
    }
  }

  async writePage(pageId: PageId, buf: Buffer): Promise<void> {
    const offset = pageId * PAGE_SIZE;
    await this.fd.write(buf, 0, PAGE_SIZE, offset);
    await this.fd.datasync(); // fsync equivalent — WAL requirement
  }

  async allocatePage(): Promise<PageId> {
    const pageId = this.numPages as PageId;
    const zeroBuf = Buffer.alloc(PAGE_SIZE);
    await this.fd.write(zeroBuf, 0, PAGE_SIZE, pageId * PAGE_SIZE);
    await this.fd.datasync();
    this.numPages++;
    return pageId;
  }

  getPageCount(): number {
    return this.numPages;
  }

  async close(): Promise<void> {
    await this.fd.close();
  }
}
