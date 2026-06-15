import type { CatalogEntry } from '../common/interfaces.js';

export interface CatalogStorage {
  load(): Promise<Record<string, CatalogEntry>>;
  save(state: Record<string, CatalogEntry>): Promise<void>;
}
