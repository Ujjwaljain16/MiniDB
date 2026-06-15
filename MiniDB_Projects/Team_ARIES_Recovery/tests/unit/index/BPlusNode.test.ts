import { BPlusNode, BPLUS_HEADER_SIZE } from '../../../src/index/BPlusNode';
import type { ColumnDef, PageId, RID } from '../../../src/common/types';
import { makeRID } from '../../../src/common/types';

describe('BPlusNode', () => {
  const colDefInt: ColumnDef = { name: 'id', type: 'INT', nullable: false };
  const colDefVarchar: ColumnDef = { name: 'name', type: 'VARCHAR', maxLen: 10, nullable: false };

  it('calculates capacities correctly', () => {
    const buf = Buffer.alloc(4096);
    const node = new BPlusNode(buf, colDefInt); // keySize = 4
    
    // maxLeafEntries = floor((4096 - 24) / 10) = 407
    expect(node.maxLeafEntries).toBe(407);
    
    // maxInternalKeys = floor((4096 - 24 - 4) / 8) = 508
    expect(node.maxInternalKeys).toBe(508);
  });

  it('inserts and deletes from leaf node (INT keys)', () => {
    const buf = Buffer.alloc(4096);
    const node = new BPlusNode(buf, colDefInt);
    node.init(1 as PageId, true, 0 as PageId);

    // Insert keys in random order
    node.insertLeafEntry(50, makeRID(10 as PageId, 1));
    node.insertLeafEntry(20, makeRID(10 as PageId, 2));
    node.insertLeafEntry(80, makeRID(10 as PageId, 3));

    expect(node.numKeys).toBe(3);
    
    // Verify sorted order
    expect(node.getLeafEntry(0).key).toBe(20);
    expect(node.getLeafEntry(1).key).toBe(50);
    expect(node.getLeafEntry(2).key).toBe(80);

    // Binary search
    expect(node.binarySearch(20)).toEqual(makeRID(10 as PageId, 2));
    expect(node.binarySearch(50)).toEqual(makeRID(10 as PageId, 1));
    expect(node.binarySearch(99)).toBeNull();

    // Delete middle key
    const deleted = node.deleteLeafEntry(50);
    expect(deleted).toBe(true);
    expect(node.numKeys).toBe(2);
    expect(node.getLeafEntry(0).key).toBe(20);
    expect(node.getLeafEntry(1).key).toBe(80);
    
    // Delete non-existent key
    expect(node.deleteLeafEntry(99)).toBe(false);
  });

  it('inserts and manages internal node (VARCHAR keys)', () => {
    const buf = Buffer.alloc(4096);
    const node = new BPlusNode(buf, colDefVarchar); // keySize = 12
    node.init(2 as PageId, false, 0 as PageId);

    // Initial state: 0 keys, but 1 child at index 0 (which is manually set in B+Tree algorithms)
    node.setChildId(0, 100 as PageId);

    node.insertInternalEntry('cherry', 101 as PageId);
    node.insertInternalEntry('apple', 102 as PageId);
    node.insertInternalEntry('banana', 103 as PageId);

    expect(node.numKeys).toBe(3);

    // Should be sorted: apple, banana, cherry
    expect(node.getInternalKey(0)).toBe('apple');
    expect(node.getInternalKey(1)).toBe('banana');
    expect(node.getInternalKey(2)).toBe('cherry');

    // Find child index
    // For 'apple', we check: K0='apple'. 'apple' >= 'apple'? No, actually 'apple' is exactly equal.
    // wait, findChildIndex behavior: key < K0 => 0, key >= K0 & key < K1 => 1
    // Let's test findChildIndex
    expect(node.findChildIndex('aardvark')).toBe(0); // < apple
    expect(node.findChildIndex('apple')).toBe(1);    // >= apple, < banana
    expect(node.findChildIndex('banana')).toBe(2);   // >= banana, < cherry
    expect(node.findChildIndex('cherry')).toBe(3);   // >= cherry
    expect(node.findChildIndex('zebra')).toBe(3);    // >= cherry

    // Delete an internal entry
    // Suppose we delete index 1 ('banana'). This should shift 'cherry' left.
    node.deleteInternalEntry(1);
    expect(node.numKeys).toBe(2);
    expect(node.getInternalKey(0)).toBe('apple');
    expect(node.getInternalKey(1)).toBe('cherry');
  });
});
