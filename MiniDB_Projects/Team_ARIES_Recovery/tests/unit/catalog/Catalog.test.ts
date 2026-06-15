import { Catalog } from '../../../src/catalog/Catalog';
import { JSONCatalogStorage } from '../../../src/catalog/JSONCatalogStorage';
import type { CatalogEntry } from '../../../src/common/interfaces';
import type { TableId } from '../../../src/common/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Catalog', () => {
  let catalog: Catalog;
  let filepath: string;

  beforeEach(() => {
    filepath = path.join(os.tmpdir(), `minidb_catalog_${Date.now()}_${Math.random()}.json`);
    const storage = new JSONCatalogStorage(filepath);
    catalog = new Catalog(storage, {} as any, {} as any);
  });

  afterEach(async () => {
    await fs.unlink(filepath).catch(() => {});
  });

  it('creates and retrieves tables', async () => {
    await catalog.load(); // should start empty
    
    const entry: Omit<CatalogEntry, 'stats'> = {
      tableId: 'users' as TableId,
      heapFile: 'users.heap',
      schema: [{ name: 'id', type: 'INT', nullable: false }],
      primaryKey: 'id',
      indexes: {}
    };

    await catalog.createTable(entry);
    expect(catalog.tables()).toEqual(['users']);

    const retrieved = catalog.getTable('users' as TableId);
    expect(retrieved.tableId).toBe('users');
    expect(retrieved.stats.rowCount).toBe(0); // stats initialized
  });

  it('persists changes to disk', async () => {
    await catalog.load();
    const entry: Omit<CatalogEntry, 'stats'> = {
      tableId: 'orders' as TableId,
      heapFile: 'orders.heap',
      schema: [],
      primaryKey: 'id',
      indexes: {}
    };
    await catalog.createTable(entry);

    // Create a new catalog instance reading the same file
    const storage2 = new JSONCatalogStorage(filepath);
    const catalog2 = new Catalog(storage2, {} as any, {} as any);
    await catalog2.load();

    expect(catalog2.tables()).toEqual(['orders']);
    const t = catalog2.getTable('orders' as TableId);
    expect(t.tableId).toBe('orders');
  });

  it('throws on duplicate tables and unknown tables', async () => {
    await catalog.load();
    const entry: Omit<CatalogEntry, 'stats'> = {
      tableId: 't1' as TableId,
      heapFile: 't1.heap',
      schema: [],
      primaryKey: 'id',
      indexes: {}
    };
    await catalog.createTable(entry);

    await expect(catalog.createTable(entry)).rejects.toThrow(/TableAlreadyExistsError/);
    expect(() => catalog.getTable('t2' as TableId)).toThrow(/TableNotFoundError/);
  });
});
