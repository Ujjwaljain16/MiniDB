import type { ICatalog, CatalogEntry, TableStats, IndexDef } from '../common/interfaces.js';
import type { TableId, IndexId, PageId } from '../common/types.js';
import { DEFAULT_HEAP_ID } from '../common/config.js';
import type { CatalogStorage } from './CatalogStorage.js';
import { HeapFile } from '../storage/HeapFile.js';
import { BPlusTree } from '../index/BPlusTree.js';

export class Catalog implements ICatalog {
  private tablesMap: Map<string, CatalogEntry> = new Map();

  constructor(
    private readonly storage: CatalogStorage,
    private readonly bufferPool: any,
    private readonly diskManager: any
  ) {}

  async load(): Promise<void> {
    const data = await this.storage.load();
    this.tablesMap = new Map(Object.entries(data));
    
    // Instantiate in-memory objects
    for (const entry of this.tablesMap.values()) {
      entry.heapId ??= this.nextHeapId();
      entry.heapFile = new HeapFile(entry.tableId as string, this.bufferPool, this.diskManager, entry.heapId);
      for (const [idxName, idxDef] of Object.entries(entry.indexes)) {
        const colDef = entry.schema.find(c => c.name === idxDef.column);
        (idxDef as any).tree = new BPlusTree(this.bufferPool, colDef!, (idxDef as any).rootPageId, async (newRoot) => {
          await this.updateIndexRoot(entry.tableId, idxName as IndexId, newRoot);
        });
      }
    }
  }

  async flush(): Promise<void> {
    const data: Record<string, any> = {};
    for (const [key, val] of this.tablesMap.entries()) {
      // Strip out the instantiated objects for serialization
      const serialized = { ...val } as any;
      serialized.heapFile = `${key}.heap`;
      
      const serializedIndexes: any = {};
      for (const [idxName, idxDef] of Object.entries(val.indexes)) {
        serializedIndexes[idxName] = { ...idxDef };
        delete serializedIndexes[idxName].tree;
      }
      serialized.indexes = serializedIndexes;
      data[key] = serialized;
    }
    await this.storage.save(data);
  }

  tables(): TableId[] {
    return Array.from(this.tablesMap.keys()) as TableId[];
  }

  /** Heap id of a table, or 0 (no owner) for a table that no longer exists. */
  heapIdOf(tableId: TableId | string | undefined): number {
    if (tableId === undefined) return 0;
    return this.tablesMap.get(tableId as string)?.heapId ?? 0;
  }

  private nextHeapId(): number {
    let max = DEFAULT_HEAP_ID - 1;
    for (const entry of this.tablesMap.values()) {
      if (entry.heapId !== undefined && entry.heapId > max) max = entry.heapId;
    }
    return max + 1;
  }

  getTable(tableId: TableId): CatalogEntry {
    const entry = this.tablesMap.get(tableId as string);
    if (!entry) throw new Error(`TableNotFoundError: Table '${tableId}' not found`);
    return entry;
  }

  async createTable(entry: Omit<CatalogEntry, 'stats' | 'heapFile'> & { heapFile?: string }): Promise<void> {
    if (this.tablesMap.has(entry.tableId as string)) {
      throw new Error(`TableAlreadyExistsError: Table '${entry.tableId}' already exists`);
    }
    
    const heapId = this.nextHeapId();
    const fullEntry: CatalogEntry = {
      ...entry,
      heapId,
      heapFile: new HeapFile(entry.tableId as string, this.bufferPool, this.diskManager, heapId, []),
      stats: {
        rowCount: 0,
        columnStats: {}
      }
    };
    
    this.tablesMap.set(entry.tableId as string, fullEntry);
    await this.flush();
  }

  async dropTable(tableId: TableId): Promise<void> {
    if (!this.tablesMap.has(tableId as string)) {
      throw new Error(`TableNotFoundError: Table '${tableId}' not found`);
    }
    await this.tablesMap.get(tableId as string)!.heapFile.releasePages();
    this.tablesMap.delete(tableId as string);
    await this.flush();
  }

  async createIndex(tableId: TableId, def: IndexDef): Promise<void> {
    const table = this.getTable(tableId);
    const colDef = table.schema.find(c => c.name === def.column);
    const tree = new BPlusTree(this.bufferPool, colDef!, def.rootPageId, async (newRoot) => {
      await this.updateIndexRoot(tableId, def.indexId, newRoot);
    });
    table.indexes[def.indexId as any] = { ...def, tree };

    const colIdx = table.schema.findIndex(c => c.name === def.column);
    for await (const [rid, tuple] of table.heapFile.scan(table.schema)) {
      const key = tuple[colIdx];
      if (key !== null && key !== undefined) await tree.insert(key, rid);
    }
    await this.flush();
  }

  async updateStats(tableId: TableId, stats: TableStats): Promise<void> {
    const table = this.getTable(tableId);
    table.stats = stats;
    await this.flush();
  }

  async updateIndexRoot(tableId: TableId, indexId: IndexId, rootPageId: PageId): Promise<void> {
    const table = this.getTable(tableId);
    if (!table.indexes[indexId as any]) {
      throw new Error(`IndexNotFoundError: Index '${indexId}' not found on table '${tableId}'`);
    }
    table.indexes[indexId as any]!.rootPageId = rootPageId;
    await this.flush();
  }
}
