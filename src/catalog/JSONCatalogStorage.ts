import * as fs from 'fs/promises';
import type { CatalogStorage } from './CatalogStorage.js';
import type { CatalogEntry } from '../common/interfaces.js';

export class JSONCatalogStorage implements CatalogStorage {
  constructor(private readonly filepath: string) {}

  async load(): Promise<Record<string, CatalogEntry>> {
    try {
      const data = await fs.readFile(this.filepath, 'utf-8');
      return JSON.parse(data);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return {}; // File doesn't exist yet, return empty catalog
      }
      throw e;
    }
  }

  async save(state: Record<string, CatalogEntry>): Promise<void> {
    await fs.writeFile(this.filepath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
