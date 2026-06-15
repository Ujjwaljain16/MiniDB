import type { ICatalog, CatalogEntry, TableStats, IndexDef } from '../common/interfaces.js';
import type { TableId, IndexId, PageId } from '../common/types.js';
import type { CatalogStorage } from './CatalogStorage.js';

export class Catalog implements ICatalog {
  private tablesMap: Map<string, CatalogEntry> = new Map();

  constructor(private readonly storage: CatalogStorage) {}

  async load(): Promise<void> {
    const data = await this.storage.load();
    this.tablesMap = new Map(Object.entries(data));
  }

  async flush(): Promise<void> {
    const data: Record<string, CatalogEntry> = {};
    for (const [key, val] of this.tablesMap.entries()) {
      data[key] = val;
    }
    await this.storage.save(data);
  }

  tables(): TableId[] {
    return Array.from(this.tablesMap.keys()) as TableId[];
  }

  getTable(tableId: TableId): CatalogEntry {
    const entry = this.tablesMap.get(tableId as string);
    if (!entry) throw new Error(`TableNotFoundError: Table '${tableId}' not found`);
    return entry;
  }

  async createTable(entry: Omit<CatalogEntry, 'stats'>): Promise<void> {
    if (this.tablesMap.has(entry.tableId as string)) {
      throw new Error(`TableAlreadyExistsError: Table '${entry.tableId}' already exists`);
    }
    
    const fullEntry: CatalogEntry = {
      ...entry,
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
    this.tablesMap.delete(tableId as string);
    await this.flush();
  }

  async createIndex(tableId: TableId, def: IndexDef): Promise<void> {
    const table = this.getTable(tableId);
    table.indexes[def.indexId as any] = def;
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
