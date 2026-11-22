import type { IBPlusTree, IBufferPool } from '../common/interfaces.js';
import type { ColValue, RID, PageId, ColumnDef } from '../common/types.js';
import { NULL_PAGE_ID } from '../common/types.js';
import { BPlusNode } from './BPlusNode.js';
import { compareKeys } from './BPlusKeyUtils.js';

export class BPlusTree implements IBPlusTree {
  private _rootPageId: PageId;

  constructor(
    private bufferPool: IBufferPool,
    private colDef: ColumnDef,
    rootPageId: PageId = NULL_PAGE_ID,
    private onRootChange?: (newRoot: PageId) => Promise<void>
  ) {
    this._rootPageId = rootPageId;
  }

  private async setRoot(newRoot: PageId): Promise<void> {
    this._rootPageId = newRoot;
    if (this.onRootChange) {
      await this.onRootChange(newRoot);
    }
  }

  rootPageId(): PageId {
    return this._rootPageId;
  }

  async height(): Promise<number> {
    if (this._rootPageId === NULL_PAGE_ID) return 0;
    let h = 1;
    let pageId = this._rootPageId;
    while (true) {
      const buf = await this.bufferPool.fetchPage(pageId);
      const node = new BPlusNode(buf, this.colDef);
      if (node.isLeaf) {
        this.bufferPool.unpinPage(pageId, false);
        return h;
      }
      const childId = node.getChildId(0);
      this.bufferPool.unpinPage(pageId, false);
      pageId = childId;
      h++;
    }
  }

  private async fetchNode(pageId: PageId): Promise<BPlusNode> {
    const buf = await this.bufferPool.fetchPage(pageId);
    return new BPlusNode(buf, this.colDef);
  }

  async search(key: ColValue): Promise<RID | null> {
    if (this._rootPageId === NULL_PAGE_ID) return null;

    let pageId = this._rootPageId;
    while (true) {
      const node = await this.fetchNode(pageId);
      
      if (node.isLeaf) {
        const rid = node.binarySearch(key);
        this.bufferPool.unpinPage(pageId, false);
        return rid;
      }
      
      const childIdx = node.findChildIndex(key);
      const childId = node.getChildId(childIdx);
      this.bufferPool.unpinPage(pageId, false);
      pageId = childId;
    }
  }

  /**
   * Yields RIDs with `low <= key <= high` in key order. A null bound is open:
   * null `low` starts at the leftmost leaf, null `high` runs to the last leaf.
   * Stopping the iterator early (return()) unpins the leaf it was on.
   */
  async *searchRange(low: ColValue | null, high: ColValue | null): AsyncIterableIterator<RID> {
    if (this._rootPageId === NULL_PAGE_ID) return;

    let pageId = this._rootPageId;
    let currentNode: BPlusNode | null = null;

    try {
      while (true) {
        currentNode = await this.fetchNode(pageId);

        if (currentNode.isLeaf) break;

        const childIdx = low === null ? 0 : this.lowerBoundChild(currentNode, low);
        const childId = currentNode.getChildId(childIdx);
        this.bufferPool.unpinPage(pageId, false);
        currentNode = null;
        pageId = childId;
      }

      while (pageId !== NULL_PAGE_ID && currentNode) {
        const n = currentNode.numKeys;
        let done = false;

        for (let i = 0; i < n; i++) {
          const { key, rid } = currentNode.getLeafEntry(i);

          if (high !== null && compareKeys(key, high, this.colDef) > 0) {
            done = true;
            break;
          }

          if (low === null || compareKeys(key, low, this.colDef) >= 0) {
            yield rid;
          }
        }
        
        if (done) {
          this.bufferPool.unpinPage(pageId, false);
          currentNode = null;
          break;
        }
        
        const nextId = currentNode.nextLeafId;
        this.bufferPool.unpinPage(pageId, false);
        currentNode = null;
        
        pageId = nextId;
        if (pageId !== NULL_PAGE_ID) {
          currentNode = await this.fetchNode(pageId);
        }
      }
    } finally {
      if (currentNode) {
        this.bufferPool.unpinPage(currentNode.pageId, false);
      }
    }
  }

  /**
   * Snapshot of every node, breadth-first from the root, for visualisation.
   * Leaves have no children; internal nodes have nextLeafId = -1.
   */
  async describe(): Promise<{
    rootPageId: number;
    height: number;
    nodes: Array<{ pageId: number; isLeaf: boolean; keys: (number | string | boolean | null)[]; children: number[]; nextLeafId: number }>;
  }> {
    const nodes: Array<{ pageId: number; isLeaf: boolean; keys: (number | string | boolean | null)[]; children: number[]; nextLeafId: number }> = [];
    let height = 0;
    let level: PageId[] = this._rootPageId === NULL_PAGE_ID ? [] : [this._rootPageId];

    while (level.length > 0) {
      height++;
      const nextLevel: PageId[] = [];
      for (const pageId of level) {
        const node = await this.fetchNode(pageId);
        try {
          const keys: (number | string | boolean | null)[] = [];
          const children: number[] = [];
          for (let i = 0; i < node.numKeys; i++) {
            const key = node.isLeaf ? node.getLeafEntry(i).key : node.getInternalKey(i);
            keys.push(typeof key === 'bigint' ? key.toString() : key);
          }
          if (!node.isLeaf) {
            for (let i = 0; i <= node.numKeys; i++) children.push(node.getChildId(i));
            nextLevel.push(...(children as PageId[]));
          }
          nodes.push({
            pageId,
            isLeaf: node.isLeaf,
            keys,
            children,
            nextLeafId: node.isLeaf ? node.nextLeafId : NULL_PAGE_ID,
          });
        } finally {
          this.bufferPool.unpinPage(pageId, false);
        }
      }
      level = nextLevel;
    }

    return { rootPageId: this._rootPageId, height, nodes };
  }

  /**
   * First child that can hold `key`. Unlike findChildIndex this goes left on a
   * separator equal to `key`, because a leaf split can leave duplicates of the
   * separator at the end of the left sibling.
   */
  private lowerBoundChild(node: BPlusNode, key: ColValue): number {
    let lo = 0;
    let hi = node.numKeys;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeys(key, node.getInternalKey(mid), this.colDef) <= 0) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  async insert(key: ColValue, rid: RID): Promise<void> {
    key = this.storedKey(key);
    if (this._rootPageId === NULL_PAGE_ID) {
      // Create new root leaf node
      const [newId, buf] = await this.bufferPool.newPage();
      const node = new BPlusNode(buf, this.colDef);
      node.init(newId, true);
      node.insertLeafEntry(key, rid);
      await this.setRoot(newId);
      this.bufferPool.unpinPage(newId, true);
      return;
    }

    const parentPath: BPlusNode[] = [];
    let pageId = this._rootPageId;
    let leafNode: BPlusNode;

    // 1. Descend to correct leaf
    while (true) {
      const node = await this.fetchNode(pageId);
      if (node.isLeaf) {
        leafNode = node;
        break;
      }
      parentPath.push(node);
      const childIdx = node.findChildIndex(key);
      pageId = node.getChildId(childIdx);
    }

    // 2. If leaf has space
    if (leafNode.numKeys < leafNode.maxLeafEntries) {
      leafNode.insertLeafEntry(key, rid);
      this.bufferPool.unpinPage(leafNode.pageId, true);
      
      // Unpin parent path
      for (const p of parentPath) {
        this.bufferPool.unpinPage(p.pageId, false);
      }
      return;
    }

    // 3. Leaf is full: split
    const [rightId, rightBuf] = await this.bufferPool.newPage();
    const rightLeaf = new BPlusNode(rightBuf, this.colDef);
    rightLeaf.init(rightId, true, leafNode.parentPageId);
    rightLeaf.nextLeafId = leafNode.nextLeafId;
    leafNode.nextLeafId = rightId;

    // Collect all entries including the new one
    const allEntries = [];
    for (let i = 0; i < leafNode.numKeys; i++) {
      allEntries.push(leafNode.getLeafEntry(i));
    }
    allEntries.push({ key, rid });
    allEntries.sort((a, b) => compareKeys(a.key, b.key, this.colDef));

    // Redistribute
    leafNode.numKeys = 0;
    rightLeaf.numKeys = 0;
    
    const midIdx = Math.ceil(allEntries.length / 2);
    for (let i = 0; i < midIdx; i++) {
      leafNode.insertLeafEntry(allEntries[i]!.key, allEntries[i]!.rid);
    }
    for (let i = midIdx; i < allEntries.length; i++) {
      rightLeaf.insertLeafEntry(allEntries[i]!.key, allEntries[i]!.rid);
    }

    const medianKey = rightLeaf.getLeafEntry(0).key;
    this.bufferPool.unpinPage(leafNode.pageId, true);
    this.bufferPool.unpinPage(rightLeaf.pageId, true);

    await this.insertIntoParent(leafNode.pageId, medianKey, rightLeaf.pageId, parentPath);
  }

  private async insertIntoParent(leftId: PageId, key: ColValue, rightId: PageId, parentPath: BPlusNode[]): Promise<void> {
    if (parentPath.length === 0) {
      // Root split
      const [newRootId, rootBuf] = await this.bufferPool.newPage();
      const newRoot = new BPlusNode(rootBuf, this.colDef);
      newRoot.init(newRootId, false);
      newRoot.setChildId(0, leftId);
      newRoot.insertInternalEntry(key, rightId);
      
      await this.setRoot(newRootId);
      this.bufferPool.unpinPage(newRootId, true);
      
      // Update parents of children
      const [leftNode] = [await this.fetchNode(leftId)];
      leftNode.parentPageId = newRootId;
      this.bufferPool.unpinPage(leftId, true);

      const [rightNode] = [await this.fetchNode(rightId)];
      rightNode.parentPageId = newRootId;
      this.bufferPool.unpinPage(rightId, true);
      return;
    }

    const parent = parentPath.pop()!;
    if (parent.numKeys < parent.maxInternalKeys) {
      parent.insertInternalEntry(key, rightId);
      this.bufferPool.unpinPage(parent.pageId, true);
      
      // Unpin remaining path
      for (const p of parentPath) {
        this.bufferPool.unpinPage(p.pageId, false);
      }
      
      // Update right node parent
      const [rightNode] = [await this.fetchNode(rightId)];
      rightNode.parentPageId = parent.pageId;
      this.bufferPool.unpinPage(rightId, true);
      return;
    }

    // Parent is full: split internal node
    const [newParentId, newParentBuf] = await this.bufferPool.newPage();
    const rightParent = new BPlusNode(newParentBuf, this.colDef);
    rightParent.init(newParentId, false, parent.parentPageId);

    // Collect all keys + children
    const allKeys = [];
    const allChildren = [parent.getChildId(0)];
    for (let i = 0; i < parent.numKeys; i++) {
      allKeys.push(parent.getInternalKey(i));
      allChildren.push(parent.getChildId(i + 1));
    }

    // Insert new key and child into sorted position
    let insertIdx = 0;
    while (insertIdx < allKeys.length) {
      if (compareKeys(key, allKeys[insertIdx]!, this.colDef) < 0) break;
      insertIdx++;
    }
    allKeys.splice(insertIdx, 0, key);
    allChildren.splice(insertIdx + 1, 0, rightId);

    // Redistribute
    parent.numKeys = 0;
    rightParent.numKeys = 0;
    
    const midIdx = Math.floor(allKeys.length / 2);
    const splitKey = allKeys[midIdx]!;
    
    parent.setChildId(0, allChildren[0]!);
    for (let i = 0; i < midIdx; i++) {
      parent.insertInternalEntry(allKeys[i]!, allChildren[i + 1]!);
    }
    
    rightParent.setChildId(0, allChildren[midIdx + 1]!);
    for (let i = midIdx + 1; i < allKeys.length; i++) {
      rightParent.insertInternalEntry(allKeys[i]!, allChildren[i + 1]!);
    }

    // Update parent pointers for children moved to rightParent
    for (let i = 0; i <= rightParent.numKeys; i++) {
      const childId = rightParent.getChildId(i);
      const childNode = await this.fetchNode(childId);
      childNode.parentPageId = rightParent.pageId;
      this.bufferPool.unpinPage(childId, true);
    }

    this.bufferPool.unpinPage(parent.pageId, true);
    this.bufferPool.unpinPage(rightParent.pageId, true);

    await this.insertIntoParent(parent.pageId, splitKey, rightParent.pageId, parentPath);
  }

  /**
   * Remove the entry for `key`. With duplicate keys, pass the row's `rid` so
   * the entry of that row (not just any row with the same key) is removed.
   */
  async delete(key: ColValue, rid?: RID): Promise<void> {
    if (this._rootPageId === NULL_PAGE_ID) return;

    const found = await this.findLeafEntry(this._rootPageId, this.storedKey(key), rid, []);
    if (!found) return; // Key not found
    const { leaf: leafNode, index, path: parentPath } = found;

    this.removeLeafEntryAt(leafNode, index);

    // Check underflow
    const minKeys = Math.ceil((leafNode.maxLeafEntries - 1) / 2);
    if (leafNode.pageId === this._rootPageId || leafNode.numKeys >= minKeys) {
      this.bufferPool.unpinPage(leafNode.pageId, true);
      for (const p of parentPath) this.bufferPool.unpinPage(p.pageId, false);
      return;
    }

    // Handle underflow
    this.bufferPool.unpinPage(leafNode.pageId, true);
    await this.handleUnderflow(leafNode.pageId, parentPath);
  }

  /**
   * Find the leaf entry for (key, rid), trying every child whose range can hold
   * `key` since duplicates may span several leaves. On success the leaf and
   * the returned path stay pinned, as delete's underflow handling expects.
   */
  private async findLeafEntry(
    pageId: PageId, key: ColValue, rid: RID | undefined, path: BPlusNode[]
  ): Promise<{ leaf: BPlusNode; index: number; path: BPlusNode[] } | null> {
    const node = await this.fetchNode(pageId);
    if (node.isLeaf) {
      for (let i = 0; i < node.numKeys; i++) {
        const entry = node.getLeafEntry(i);
        const cmp = compareKeys(entry.key, key, this.colDef);
        if (cmp > 0) break;
        if (cmp === 0 && (!rid || (entry.rid.pageId === rid.pageId && entry.rid.slotId === rid.slotId))) {
          return { leaf: node, index: i, path };
        }
      }
      this.bufferPool.unpinPage(pageId, false);
      return null;
    }

    const last = node.findChildIndex(key);
    for (let i = this.lowerBoundChild(node, key); i <= last; i++) {
      const found = await this.findLeafEntry(node.getChildId(i), key, rid, [...path, node]);
      if (found) return found;
    }
    this.bufferPool.unpinPage(pageId, false);
    return null;
  }

  /** BPlusNode can only delete the first entry with a key, so swap the target into that slot first. */
  private removeLeafEntryAt(node: BPlusNode, index: number): void {
    const { key, rid } = node.getLeafEntry(index);
    let first = index;
    while (first > 0 && compareKeys(node.getLeafEntry(first - 1).key, key, this.colDef) === 0) first--;
    if (first !== index) {
      node.setLeafEntry(index, key, node.getLeafEntry(first).rid);
      node.setLeafEntry(first, key, rid);
    }
    node.deleteLeafEntry(key);
  }

  /** NULL keys are written to the page as zero bytes, so order and match them as that value. */
  private storedKey(key: ColValue): ColValue {
    if (key !== null) return key;
    switch (this.colDef.type) {
      case 'VARCHAR': return '';
      case 'BOOL': return false;
      case 'BIGINT': return 0n;
      default: return 0;
    }
  }

  private async handleUnderflow(pageId: PageId, parentPath: BPlusNode[]): Promise<void> {
    if (parentPath.length === 0) {
      // It's the root.
      const [rootNode] = [await this.fetchNode(pageId)];
      if (!rootNode.isLeaf && rootNode.numKeys === 0) {
        // Root is internal and has only 1 child. Make the child the new root.
        await this.setRoot(rootNode.getChildId(0));
        const [newRootNode] = [await this.fetchNode(this._rootPageId)];
        newRootNode.parentPageId = NULL_PAGE_ID;
        this.bufferPool.unpinPage(this._rootPageId, true);
        // Note: old root is conceptually deallocated here, but we don't have page deallocation in DiskManager yet.
      }
      this.bufferPool.unpinPage(pageId, false);
      return;
    }

    const parent = parentPath[parentPath.length - 1]!;
    // Find index of this node in parent
    let myIdx = -1;
    for (let i = 0; i <= parent.numKeys; i++) {
      if (parent.getChildId(i) === pageId) {
        myIdx = i;
        break;
      }
    }

    const [node] = [await this.fetchNode(pageId)];
    const isLeaf = node.isLeaf;
    const minKeys = Math.ceil((node.maxKeys - 1) / 2);

    if (node.numKeys >= minKeys) {
      this.bufferPool.unpinPage(pageId, false);
      for (const p of parentPath) this.bufferPool.unpinPage(p.pageId, false);
      return;
    }

    // Try borrow from left sibling
    if (myIdx > 0) {
      const leftSiblingId = parent.getChildId(myIdx - 1);
      const [leftSibling] = [await this.fetchNode(leftSiblingId)];
      if (leftSibling.numKeys > minKeys) {
        // Borrow
        if (isLeaf) {
          const entry = leftSibling.getLeafEntry(leftSibling.numKeys - 1);
          this.removeLeafEntryAt(leftSibling, leftSibling.numKeys - 1);
          node.insertLeafEntry(entry.key, entry.rid);
          parent.setInternalKey(myIdx - 1, node.getLeafEntry(0).key);
        } else {
          const keyToMoveDown = parent.getInternalKey(myIdx - 1);
          const childToMove = leftSibling.getChildId(leftSibling.numKeys);
          const keyToMoveUp = leftSibling.getInternalKey(leftSibling.numKeys - 1);
          
          leftSibling.numKeys--;
          node.insertInternalEntry(keyToMoveDown, node.getChildId(0)); // shift right
          node.setChildId(0, childToMove);
          parent.setInternalKey(myIdx - 1, keyToMoveUp);
          
          const [movedChild] = [await this.fetchNode(childToMove)];
          movedChild.parentPageId = node.pageId;
          this.bufferPool.unpinPage(childToMove, true);
        }
        
        this.bufferPool.unpinPage(leftSibling.pageId, true);
        this.bufferPool.unpinPage(node.pageId, true);
        this.bufferPool.unpinPage(parent.pageId, true);
        for (let i = 0; i < parentPath.length - 1; i++) this.bufferPool.unpinPage(parentPath[i]!.pageId, false);
        return;
      }
      this.bufferPool.unpinPage(leftSibling.pageId, false);
    }

    // Try borrow from right sibling
    if (myIdx < parent.numKeys) {
      const rightSiblingId = parent.getChildId(myIdx + 1);
      const [rightSibling] = [await this.fetchNode(rightSiblingId)];
      if (rightSibling.numKeys > minKeys) {
        // Borrow
        if (isLeaf) {
          const entry = rightSibling.getLeafEntry(0);
          rightSibling.deleteLeafEntry(entry.key);
          node.insertLeafEntry(entry.key, entry.rid);
          parent.setInternalKey(myIdx, rightSibling.getLeafEntry(0).key);
        } else {
          const keyToMoveDown = parent.getInternalKey(myIdx);
          const childToMove = rightSibling.getChildId(0);
          const keyToMoveUp = rightSibling.getInternalKey(0);
          
          node.insertInternalEntry(keyToMoveDown, childToMove);
          
          // shift rightSibling left
          for (let i = 0; i < rightSibling.numKeys - 1; i++) {
            rightSibling.setInternalKey(i, rightSibling.getInternalKey(i + 1));
          }
          for (let i = 0; i < rightSibling.numKeys; i++) {
            rightSibling.setChildId(i, rightSibling.getChildId(i + 1));
          }
          rightSibling.numKeys--;
          
          parent.setInternalKey(myIdx, keyToMoveUp);
          
          const [movedChild] = [await this.fetchNode(childToMove)];
          movedChild.parentPageId = node.pageId;
          this.bufferPool.unpinPage(childToMove, true);
        }
        
        this.bufferPool.unpinPage(rightSibling.pageId, true);
        this.bufferPool.unpinPage(node.pageId, true);
        this.bufferPool.unpinPage(parent.pageId, true);
        for (let i = 0; i < parentPath.length - 1; i++) this.bufferPool.unpinPage(parentPath[i]!.pageId, false);
        return;
      }
      this.bufferPool.unpinPage(rightSibling.pageId, false);
    }

    // Merge with a sibling. Prefer merging node into leftSibling.
    let leftNode: BPlusNode;
    let rightNode: BPlusNode;
    let parentKeyIdx: number;

    if (myIdx > 0) {
      const leftSiblingId = parent.getChildId(myIdx - 1);
      leftNode = await this.fetchNode(leftSiblingId);
      rightNode = node;
      parentKeyIdx = myIdx - 1;
    } else {
      leftNode = node;
      const rightSiblingId = parent.getChildId(myIdx + 1);
      rightNode = await this.fetchNode(rightSiblingId);
      parentKeyIdx = myIdx;
    }

    // Merge right into left
    if (isLeaf) {
      for (let i = 0; i < rightNode.numKeys; i++) {
        const { key, rid } = rightNode.getLeafEntry(i);
        leftNode.insertLeafEntry(key, rid);
      }
      leftNode.nextLeafId = rightNode.nextLeafId;
    } else {
      const keyToMoveDown = parent.getInternalKey(parentKeyIdx);
      leftNode.insertInternalEntry(keyToMoveDown, rightNode.getChildId(0));
      const child0 = await this.fetchNode(rightNode.getChildId(0));
      child0.parentPageId = leftNode.pageId;
      this.bufferPool.unpinPage(child0.pageId, true);
      
      for (let i = 0; i < rightNode.numKeys; i++) {
        const k = rightNode.getInternalKey(i);
        const c = rightNode.getChildId(i + 1);
        leftNode.insertInternalEntry(k, c);
        const child = await this.fetchNode(c);
        child.parentPageId = leftNode.pageId;
        this.bufferPool.unpinPage(child.pageId, true);
      }
    }

    this.bufferPool.unpinPage(leftNode.pageId, true);
    this.bufferPool.unpinPage(rightNode.pageId, false);

    parent.deleteInternalEntry(parentKeyIdx);
    this.bufferPool.unpinPage(parent.pageId, true);
    
    const grandParentPath = parentPath.slice(0, -1);
    await this.handleUnderflow(parent.pageId, grandParentPath);
  }

  async bulkLoad(entries: ReadonlyArray<[ColValue, RID]>): Promise<void> {
    if (entries.length === 0) return;

    // We build leaves left-to-right at 70% capacity
    // 1. Create a dummy node just to read capacities
    const [dummyId, dummyBuf] = await this.bufferPool.newPage();
    const dummyNode = new BPlusNode(dummyBuf, this.colDef);
    const leafFill = Math.max(1, Math.floor(dummyNode.maxLeafEntries * 0.7));
    const intFill = Math.max(2, Math.floor(dummyNode.maxInternalKeys * 0.7)); // min 2 children
    this.bufferPool.unpinPage(dummyId, false);
    // Note: this leaks dummyId as 1 page, but it's okay for our simple test setup.
    // In a real system, we'd just instantiate a BPlusNode on a free buffer to check max entries.
    
    // We will build the tree level by level
    let currentLevel: { pageId: PageId, firstKey: ColValue }[] = [];
    
    // 2. Build leaf level
    let currentLeaf: BPlusNode | null = null;
    let prevLeaf: BPlusNode | null = null;
    
    for (let i = 0; i < entries.length; i++) {
      if (!currentLeaf || currentLeaf.numKeys >= leafFill) {
        const [newId, buf] = await this.bufferPool.newPage();
        const leaf = new BPlusNode(buf, this.colDef);
        leaf.init(newId, true);
        
        if (prevLeaf) {
          prevLeaf.nextLeafId = newId;
          this.bufferPool.unpinPage(prevLeaf.pageId, true);
        }
        
        currentLeaf = leaf;
        prevLeaf = currentLeaf;
        currentLevel.push({ pageId: newId, firstKey: entries[i]![0] });
      }
      currentLeaf.insertLeafEntry(entries[i]![0], entries[i]![1]);
    }
    
    if (currentLeaf) {
      this.bufferPool.unpinPage(currentLeaf.pageId, true);
    }
    
    // 3. Build internal levels until we have 1 root
    while (currentLevel.length > 1) {
      const nextLevel: { pageId: PageId, firstKey: ColValue }[] = [];
      let currentInternal: BPlusNode | null = null;
      
      for (let i = 0; i < currentLevel.length; i++) {
        if (!currentInternal || currentInternal.numKeys >= intFill) {
          const [newId, buf] = await this.bufferPool.newPage();
          currentInternal = new BPlusNode(buf, this.colDef);
          currentInternal.init(newId, false);
          
          currentInternal.setChildId(0, currentLevel[i]!.pageId);
          // Set parent pointer
          const [child] = [await this.fetchNode(currentLevel[i]!.pageId)];
          child.parentPageId = newId;
          this.bufferPool.unpinPage(child.pageId, true);
          
          nextLevel.push({ pageId: newId, firstKey: currentLevel[i]!.firstKey });
        } else {
          currentInternal.insertInternalEntry(currentLevel[i]!.firstKey, currentLevel[i]!.pageId);
          // Set parent pointer
          const [child] = [await this.fetchNode(currentLevel[i]!.pageId)];
          child.parentPageId = currentInternal.pageId;
          this.bufferPool.unpinPage(child.pageId, true);
        }
      }
      
      if (currentInternal) {
        this.bufferPool.unpinPage(currentInternal.pageId, true);
      }
      
      currentLevel = nextLevel;
    }
    
    await this.setRoot(currentLevel[0]!.pageId);
  }

  async debugValidate(): Promise<void> {
    if (this._rootPageId === NULL_PAGE_ID) return;

    let leafDepth = -1;

    const dfs = async (pageId: PageId, depth: number, parentId: PageId, minKey: ColValue | null, maxKey: ColValue | null): Promise<void> => {
      const node = await this.fetchNode(pageId);
      
      try {
        // 1. Parent pointer
        if (node.parentPageId !== parentId) {
          throw new Error(`Parent pointer mismatch at page ${pageId}: expected ${parentId}, got ${node.parentPageId}`);
        }

        // 2. Occupancy (except root)
        if (pageId !== this._rootPageId) {
          const minKeys = Math.ceil((node.maxKeys - 1) / 2);
          if (node.numKeys < minKeys || node.numKeys > node.maxKeys) {
            throw new Error(`Occupancy violation at page ${pageId}: numKeys=${node.numKeys}, min=${minKeys}, max=${node.maxKeys}`);
          }
        }

        if (node.isLeaf) {
          // Leaf checks
          if (leafDepth === -1) {
            leafDepth = depth;
          } else if (leafDepth !== depth) {
            throw new Error(`Height inconsistency: leaf at depth ${depth}, expected ${leafDepth}`);
          }

          // Order and bounds
          for (let i = 0; i < node.numKeys; i++) {
            const k = node.getLeafEntry(i).key;
            if (i > 0 && compareKeys(node.getLeafEntry(i - 1).key, k, this.colDef) >= 0) {
              throw new Error(`Leaf keys not strictly sorted at page ${pageId}`);
            }
            if (minKey !== null && compareKeys(k, minKey, this.colDef) < 0) {
              throw new Error(`Leaf key ${k} < min bound ${minKey} at page ${pageId}`);
            }
            if (maxKey !== null && compareKeys(k, maxKey, this.colDef) >= 0) {
              throw new Error(`Leaf key ${k} >= max bound ${maxKey} at page ${pageId}`);
            }
          }
        } else {
          // Internal checks
          if (node.numKeys === 0 && pageId !== this._rootPageId) {
            throw new Error(`Internal node ${pageId} has 0 keys (not root)`);
          }

          for (let i = 0; i < node.numKeys; i++) {
            const k = node.getInternalKey(i);
            if (i > 0 && compareKeys(node.getInternalKey(i - 1), k, this.colDef) >= 0) {
              throw new Error(`Internal keys not strictly sorted at page ${pageId}`);
            }
          }

          for (let i = 0; i <= node.numKeys; i++) {
            const childId = node.getChildId(i);
            const nextMin = i === 0 ? minKey : node.getInternalKey(i - 1);
            const nextMax = i === node.numKeys ? maxKey : node.getInternalKey(i);
            
            await dfs(childId, depth + 1, pageId, nextMin, nextMax);
          }
        }
      } finally {
        this.bufferPool.unpinPage(pageId, false);
      }
    };

    await dfs(this._rootPageId, 0, NULL_PAGE_ID, null, null);

    // Check leaf chain
    let curr = this._rootPageId;
    while (true) {
      const node = await this.fetchNode(curr);
      const isLeaf = node.isLeaf;
      const child0 = isLeaf ? NULL_PAGE_ID : node.getChildId(0);
      this.bufferPool.unpinPage(curr, false);
      if (isLeaf) break;
      curr = child0;
    }

    while (curr !== NULL_PAGE_ID) {
      const node = await this.fetchNode(curr);
      const nextId = node.nextLeafId;
      this.bufferPool.unpinPage(curr, false);
      
      if (nextId !== NULL_PAGE_ID) {
        const nextNode = await this.fetchNode(nextId);
        if (!nextNode.isLeaf) {
          this.bufferPool.unpinPage(nextId, false);
          throw new Error(`Next leaf pointer points to internal node ${nextId}`);
        }
        this.bufferPool.unpinPage(nextId, false);
      }
      curr = nextId;
    }
  }
}
