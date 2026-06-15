// src/catalog/Catalog.ts — Phase 3

import type { ICatalog, CatalogEntry, IndexDef, TableStats } from '../common/interfaces.js';
import type { TableId, IndexId, PageId } from '../common/types.js';

export class Catalog implements ICatalog {
  constructor(_dataDir: string) {
    throw new Error('Catalog: not yet implemented — Phase 3');
  }
  load(): Promise<void> { throw new Error('NYI'); }
  flush(): Promise<void> { throw new Error('NYI'); }
  tables(): TableId[] { throw new Error('NYI'); }
  getTable(_tableId: TableId): CatalogEntry { throw new Error('NYI'); }
  createTable(_entry: Omit<CatalogEntry, 'stats'>): Promise<void> { throw new Error('NYI'); }
  dropTable(_tableId: TableId): Promise<void> { throw new Error('NYI'); }
  createIndex(_tableId: TableId, _def: IndexDef): Promise<void> { throw new Error('NYI'); }
  updateStats(_tableId: TableId, _stats: TableStats): Promise<void> { throw new Error('NYI'); }
  updateIndexRoot(_tableId: TableId, _indexId: IndexId, _rootPageId: PageId): Promise<void> { throw new Error('NYI'); }
}
