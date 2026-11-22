import type { CatalogStorage } from './CatalogStorage.js';
import type { CatalogEntry } from '../common/interfaces.js';

/** Catalog storage that lives in memory; state goes through JSON just like the file version. */
export class MemCatalogStorage implements CatalogStorage {
  private json = '{}';

  async load(): Promise<Record<string, CatalogEntry>> {
    return JSON.parse(this.json);
  }

  async save(state: Record<string, CatalogEntry>): Promise<void> {
    this.json = JSON.stringify(state);
  }
}
