import { DiskManager } from '../src/storage/DiskManager.js';
import { BufferPool } from '../src/storage/BufferPool.js';
import { LogManager } from '../src/recovery/LogManager.js';
import { Catalog } from '../src/catalog/Catalog.js';
import { JSONCatalogStorage } from '../src/catalog/JSONCatalogStorage.js';
import { BPlusTree } from '../src/index/BPlusTree.js';
import { ColumnDef, PageId, TableId, IndexId, RID } from '../src/common/types.js';
import * as fs from 'fs';

describe('BPlusTree Persistence', () => {
  it('survives restart and retains root page ID', async () => {
  
  const testDir = './test_persistence_data';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir);

  const dbFile = `${testDir}/test.db`;
  const logFile = `${testDir}/test.log`;
  const catFile = `${testDir}/catalog.json`;

  const diskManager = await DiskManager.open(dbFile);
  const logManager = new LogManager(logFile);
  await logManager.init();
  const bufferPool = new BufferPool(diskManager, logManager, 100);
  
  const catalogStorage = new JSONCatalogStorage(catFile);
  const catalog = new Catalog(catalogStorage, bufferPool, diskManager);
  await catalog.load();

  const tableId = 'test_table' as TableId;
  const indexId = 'test_idx' as IndexId;

  await catalog.createTable({
    tableId,
    schema: [
      { name: 'id', type: 'INT', nullable: false }
    ],
    primaryKey: '' as any,
    indexes: {}
  });

  await catalog.createIndex(tableId, {
    indexId,
    type: 'btree',
    column: 'id',
    indexFile: 'test.tree',
    rootPageId: -1 as PageId // NULL_PAGE_ID
  });

  // Get the column definition for the B+ Tree
  const colDef: ColumnDef = catalog.getTable(tableId).schema[0]!;

  let tableEntry = catalog.getTable(tableId);
  let tree = (tableEntry.indexes[indexId as any] as any).tree as BPlusTree;

  console.log(`Initial root page ID: ${tree.rootPageId()}`);

  // 2. Insert enough keys to force a root split. 
  // Let's insert 1000 keys.
  console.log('Inserting 1000 keys to force root split...');
  for (let i = 0; i < 1000; i++) {
    const rid: RID = { pageId: i as PageId, slotId: i as any };
    await tree.insert(i, rid);
  }

  const finalRootId = tree.rootPageId();
  console.log(`Root page ID after inserts: ${finalRootId}`);
  if (finalRootId === 0 as PageId) {
    throw new Error('Root page ID did not change. Test is invalid.');
  }

  // Ensure everything is flushed
  await bufferPool.flushAll();
  await catalog.flush();

  // 3. Destroy/Close the existing instances
  console.log('Closing and re-opening database to test persistence...');
  await logManager.flush(logManager.currentLsn());
  await diskManager.close();

  // 4. Reopen Database
  const diskManager2 = await DiskManager.open(dbFile);
  const logManager2 = new LogManager(logFile);
  await logManager2.init();
  const bufferPool2 = new BufferPool(diskManager2, logManager2, 100);
  
  const catalogStorage2 = new JSONCatalogStorage(catFile);
  const catalog2 = new Catalog(catalogStorage2, bufferPool2, diskManager2);
  
  // 5. Load catalog (this should rebuild the B+ tree with the correctly persisted root page)
  await catalog2.load();

  const tableEntry2 = catalog2.getTable(tableId);
  const tree2 = (tableEntry2.indexes[indexId as any] as any).tree as BPlusTree;

  const reopenedRootId = tree2.rootPageId();
  console.log(`Reopened root page ID: ${reopenedRootId}`);
  
  if (reopenedRootId !== finalRootId) {
    throw new Error(`CRITICAL BUG: Reopened tree root (${reopenedRootId}) does not match expected final root (${finalRootId})`);
  }

  // 6. Search all keys
  console.log('Verifying all 1000 keys can be searched from the reopened index...');
  let missingCount = 0;
  for (let i = 0; i < 1000; i++) {
    const res = await tree2.search(i);
    if (!res || res.pageId !== i || res.slotId !== i) {
      missingCount++;
    }
  }

  if (missingCount > 0) {
    throw new Error(`CRITICAL BUG: ${missingCount} keys were missing or corrupted after reopening the index.`);
  }

  console.log('Success! Root tracking is working correctly across restarts.');

  // Cleanup
  await logManager2.flush(logManager2.currentLsn());
  await diskManager2.close();
  fs.rmSync(testDir, { recursive: true, force: true });
  });
});
