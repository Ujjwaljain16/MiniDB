import { Page } from '../../../src/storage/Page';
import { PAGE_SIZE, SLOT_TOMBSTONE } from '../../../src/common/config';
import type { PageId, SlotId } from '../../../src/common/types';

describe('Page', () => {
  let buf: Buffer;
  let page: Page;

  beforeEach(() => {
    buf = Buffer.alloc(PAGE_SIZE);
    page = new Page(buf);
    page.init(42 as PageId, 0); // pageId=42, type=heap
  });

  it('initializes correctly', () => {
    expect(page.pageId).toBe(42);
    expect(page.numSlots).toBe(0);
    expect(page.freeSpacePtr).toBe(PAGE_SIZE);
    expect(page.pageType).toBe(0);
  });

  it('inserts and retrieves records', () => {
    const data1 = Buffer.from('hello');
    const slot1 = page.insertRecord(data1);
    expect(slot1).toBe(0);
    expect(page.numSlots).toBe(1);

    const data2 = Buffer.from('world!');
    const slot2 = page.insertRecord(data2);
    expect(slot2).toBe(1);
    expect(page.numSlots).toBe(2);

    const retrieved1 = page.getRecord(slot1!);
    expect(retrieved1).not.toBeNull();
    expect(retrieved1!.toString()).toBe('hello');

    const retrieved2 = page.getRecord(slot2!);
    expect(retrieved2).not.toBeNull();
    expect(retrieved2!.toString()).toBe('world!');
  });

  it('returns null when full', () => {
    // Fill the page
    const bigData = Buffer.alloc(PAGE_SIZE - 24 - 4); // leaving exactly space for 1 slot
    const slot = page.insertRecord(bigData);
    expect(slot).toBe(0);
    expect(page.freeSpace()).toBe(0);

    // Try to insert one more byte
    const tooBig = Buffer.alloc(1);
    const failSlot = page.insertRecord(tooBig);
    expect(failSlot).toBeNull();
  });

  it('deletes records and reuses tombstones', () => {
    const data1 = Buffer.from('rec1');
    const data2 = Buffer.from('rec2');
    const data3 = Buffer.from('rec3');

    const s1 = page.insertRecord(data1);
    const s2 = page.insertRecord(data2);
    const s3 = page.insertRecord(data3);

    expect(page.numSlots).toBe(3);

    page.deleteRecord(s2!);
    expect(page.getRecord(s2!)).toBeNull();

    // Insert a new record that fits in tombstone space
    const data4 = Buffer.from('new2');
    const s4 = page.insertRecord(data4);
    expect(s4).toBe(s2); // Should reuse tombstone
    expect(page.numSlots).toBe(3); // numSlots should not increase
  });

  it('compacts free space', () => {
    const s1 = page.insertRecord(Buffer.from('AAA'));
    const s2 = page.insertRecord(Buffer.from('BBB'));
    const s3 = page.insertRecord(Buffer.from('CCC'));

    page.deleteRecord(s2!);

    const initialFree = page.freeSpace();
    
    page.compact();
    
    // AAA stays at slot 0
    expect(page.getRecord(0 as SlotId)!.toString()).toBe('AAA');
    
    // BBB was deleted
    expect(page.getRecord(1 as SlotId)).toBeNull();
    
    // CCC stays at slot 2
    expect(page.getRecord(2 as SlotId)!.toString()).toBe('CCC');

    expect(page.numSlots).toBe(3); // numSlots doesn't shrink because slot 2 is still active
    // Free space should increase by the deleted record size (3 bytes)
    // The slot entry is NOT reclaimed because slot 2 exists
    expect(page.freeSpace()).toBe(initialFree + 3);
  });
});
