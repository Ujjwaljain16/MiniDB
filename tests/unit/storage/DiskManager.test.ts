import { DiskManager } from '../../../src/storage/DiskManager';
import type { PageId } from '../../../src/common/types';
import { PAGE_SIZE } from '../../../src/common/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('DiskManager', () => {
  let dm: DiskManager;
  let testFile: string;

  beforeEach(async () => {
    testFile = path.join(os.tmpdir(), `minidb_test_${Date.now()}_${Math.random()}.db`);
    dm = await DiskManager.open(testFile);
  });

  afterEach(async () => {
    await dm.close();
    await fs.unlink(testFile).catch(() => {});
  });

  it('allocates pages correctly', async () => {
    const pageId1 = await dm.allocatePage();
    expect(pageId1).toBe(0);

    const pageId2 = await dm.allocatePage();
    expect(pageId2).toBe(1);
    
    const stat = await fs.stat(testFile);
    expect(stat.size).toBe(2 * PAGE_SIZE);
  });

  it('reads and writes pages', async () => {
    const pageId = await dm.allocatePage();
    const writeBuf = Buffer.alloc(PAGE_SIZE);
    writeBuf.write('hello world', 0);
    await dm.writePage(pageId, writeBuf);

    const readBuf = Buffer.alloc(PAGE_SIZE);
    await dm.readPage(pageId, readBuf);

    expect(readBuf.toString('utf8', 0, 11)).toBe('hello world');
  });

  it('reads zeros if allocating page without writing', async () => {
    const pageId = await dm.allocatePage();
    const readBuf = Buffer.alloc(PAGE_SIZE, 1); // fill with 1s
    await dm.readPage(pageId, readBuf);
    
    // allocatePage writes a zeroBuf, so we should read back all zeros
    for (let i = 0; i < PAGE_SIZE; i++) {
      expect(readBuf[i]).toBe(0);
    }
  });
});
