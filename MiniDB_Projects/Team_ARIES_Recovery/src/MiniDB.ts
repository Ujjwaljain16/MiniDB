import path from 'path';
import { DiskManager } from './storage/DiskManager.js';
import { LogManager } from './recovery/LogManager.js';
import { BufferPool } from './storage/BufferPool.js';
import { JSONCatalogStorage } from './catalog/JSONCatalogStorage.js';
import { Catalog } from './catalog/Catalog.js';
import { LockManager } from './concurrency/LockManager.js';
import { TxnManager } from './concurrency/TxnManager.js';
import { DeadlockDetector } from './concurrency/DeadlockDetector.js';
import { recover } from './recovery/CrashRecovery.js';
import { parseSQL } from './sql/Parser.js';
import { Binder } from './sql/Binder.js';
import { PhysicalPlanner } from './optimizer/PhysicalPlanner.js';
import { Executor } from './execution/Executor.js';
import type { TxnId, ResultSet } from './common/types.js';

export class MiniDB {
  public diskManager!: DiskManager;
  public logManager!: LogManager;
  public bufferPool!: BufferPool;
  public catalog!: Catalog;
  public lockManager!: LockManager;
  public txnManager!: TxnManager;
  public deadlockDetector!: DeadlockDetector;
  
  public binder!: Binder;
  public planner!: PhysicalPlanner;
  public executor!: Executor;

  private isAcceptingQueries = false;

  constructor(private readonly dataDir: string, private readonly poolSize: number = 64) {}

  async open(): Promise<void> {
    const dbPath = path.join(this.dataDir, 'minidb.db');
    const walPath = path.join(this.dataDir, 'wal.log');
    const catalogPath = path.join(this.dataDir, 'catalog.json');

    // 1. Storage & Logging
    this.diskManager = await DiskManager.open(dbPath);
    this.logManager = new LogManager(walPath);
    await this.logManager.init();
    
    this.bufferPool = new BufferPool(this.diskManager, this.logManager, this.poolSize);

    // 2. Catalog
    const catalogStorage = new JSONCatalogStorage(catalogPath);
    this.catalog = new Catalog(catalogStorage, this.bufferPool, this.diskManager);
    await this.catalog.load();

    // 3. Concurrency
    this.lockManager = new LockManager();
    this.txnManager = new TxnManager(this.lockManager, this.logManager);

    // 4. Recovery
    await recover(this.logManager, this.bufferPool, this.txnManager, this.dataDir);

    // 5. Background Tasks
    this.deadlockDetector = new DeadlockDetector(this.lockManager, this.txnManager);
    this.deadlockDetector.start();

    // 6. SQL Layer
    this.binder = new Binder(this.catalog);
    this.planner = new PhysicalPlanner(this.catalog);
    this.executor = new Executor();

    this.isAcceptingQueries = true;
  }

  async execute(input: string, txnId?: TxnId): Promise<ResultSet> {
    if (!this.isAcceptingQueries) {
      throw new Error('MiniDB is not accepting queries. Has it been opened?');
    }

    const trimmed = input.trim();
    if (/^SHOW\s+/i.test(trimmed)) {
      return this.handleAdminCommand(trimmed);
    }

    // Wrap in auto-txn if none provided
    let autoCommit = false;
    let currentTxnId = txnId;
    let txn: any;
    if (!currentTxnId) {
      txn = await this.txnManager.begin();
      currentTxnId = txn.txnId;
      autoCommit = true;
    } else {
      txn = Array.from(this.txnManager.activeTransactions().values()).find(t => t.txnId === currentTxnId);
      if (!txn) throw new Error('Transaction not found');
    }

    try {
      const stmt = parseSQL(trimmed);
      const ctx = {
        txn,
        txnId: currentTxnId,
        txnManager: this.txnManager,
        logManager: this.logManager,
        lockManager: this.lockManager,
        bufferPool: this.bufferPool,
        catalog: this.catalog
      } as any;

      let result: ResultSet;

      if (stmt.kind === 'explain') {
        const logicalPlan = this.binder.bind(stmt.stmt);
        const physicalPlan = this.planner.plan(logicalPlan);
        if (stmt.analyze) {
          const root = this.executor.buildOperatorTree(physicalPlan);
          await root.open(ctx);
          while (await root.next()) {} // exhaust
          await root.close();
          const tree = this.executor.explainAnalyzeTree(root);
          result = { columns: ['EXPLAIN ANALYZE'], rows: [[tree]] };
        } else {
          const tree = this.executor.explainTree(physicalPlan);
          result = { columns: ['EXPLAIN'], rows: [[tree]] };
        }
      } else if (stmt.kind === 'analyze') {
        const entry = this.catalog.getTable(stmt.table as any);
        const logicalPlan = { kind: 'scan', tableId: entry.tableId, schema: entry.schema };
        const physicalPlan = this.planner.plan(logicalPlan as any);
        const scanResult = await this.executor.execute(physicalPlan, ctx);
        const columnStats: Record<string, any> = {};
        for (let i = 0; i < entry.schema.length; i++) {
          const colName = entry.schema[i]!.name;
          const distinctValues = new Set<any>();
          let min = Infinity;
          let max = -Infinity;
          
          for (const row of scanResult.rows) {
            const val = row[i];
            if (val !== null && val !== undefined) {
              distinctValues.add(val);
              if (typeof val === 'number') {
                if (val < min) min = val;
                if (val > max) max = val;
              }
            }
          }
          
          columnStats[colName] = {
            nDistinct: distinctValues.size,
            min: min === Infinity ? undefined : min,
            max: max === -Infinity ? undefined : max
          };
        }

        await this.catalog.updateStats(entry.tableId, {
          rowCount: scanResult.rows.length,
          columnStats
        });
        result = { columns: ['Result'], rows: [[`Analyzed ${stmt.table}: ${scanResult.rows.length} rows`]] };
      } else if (stmt.kind === 'create_table') {
        const schema = stmt.columns.map(c => ({
          name: c.name,
          type: c.type as any,
          nullable: c.nullable,
          maxLen: c.maxLen,
          primaryKey: c.primaryKey
        } as any));
        await this.catalog.createTable({ tableId: stmt.table as any, schema, primaryKey: '' as any, indexes: {} });
        result = { columns: ['Result'], rows: [[`Table ${stmt.table} created`]] };
      } else if (stmt.kind === 'create_index') {
        await this.catalog.createIndex(stmt.table as any, {
          indexId: stmt.indexName as any,
          type: 'btree',
          column: stmt.column,
          indexFile: `${stmt.indexName}.tree`,
          rootPageId: -1 as any
        });
        result = { columns: ['Result'], rows: [[`Index ${stmt.indexName} created on ${stmt.table}(${stmt.column})`]] };
      } else {
        const logicalPlan = this.binder.bind(stmt);
        const physicalPlan = this.planner.plan(logicalPlan);
        result = await this.executor.execute(physicalPlan, ctx);
      }
      
      if (autoCommit && currentTxnId) {
        await this.txnManager.commit(currentTxnId);
      }
      
      return result;
    } catch (err) {
      if (autoCommit && currentTxnId) {
        await this.txnManager.abort(currentTxnId).catch(console.error);
      }
      throw err;
    }
  }

  private async handleAdminCommand(cmd: string): Promise<ResultSet> {
    const tokens = cmd.replace(/;/g, '').trim().split(/\s+/);
    if (tokens.length < 2) throw new Error(`Invalid admin command: ${cmd}`);
    
    const target = tokens[1]!.toUpperCase();
    
    if (target === 'BUFFER_POOL') {
      const stats = this.bufferPool.stats();
      return {
        columns: ['Metric', 'Value'],
        rows: Object.entries(stats).map(([k, v]) => [k, v]),
      };
    } else if (target === 'WAL') {
      const records = [];
      for await (const record of this.logManager.iterator(0 as any)) {
        records.push([record.lsn, record.txnId, record.type, record.prevLsn]);
      }
      // Return last 100 for sanity
      const tail = records.slice(-100);
      return {
        columns: ['LSN', 'TxnId', 'Type', 'PrevLSN'],
        rows: tail,
      };
    } else if (target === 'TRANSACTIONS') {
      const txns = Array.from(this.txnManager.activeTransactions().values());
      return {
        columns: ['TxnId', 'State', 'BeginLSN'],
        rows: txns.map(t => [t.txnId, t.state, t.beginLsn]),
      };
    } else if (target === 'ENGINE' && tokens[2]?.toUpperCase() === 'STATUS') {
      const stats = this.bufferPool.stats();
      const txns = this.txnManager.activeTransactions();
      const lsn = this.logManager.currentLsn();
      const waiting = Array.from(txns.values()).filter(t => t.state === 'WAITING').length;
      
      const lines = [
        'Buffer Pool',
        '-----------',
        `Hit Ratio: ${(stats.hitRatio * 100).toFixed(0)}%`,
        `Dirty Pages: ${stats.dirtyPages}`,
        `Pinned Pages: ${stats.pinnedPages}`,
        '',
        'WAL',
        '---',
        `Last LSN: ${lsn}`,
        `Buffered Records: ${(this.logManager as any).logBuffer?.length || 0}`,
        '',
        'Transactions',
        '------------',
        `Active: ${txns.size}`,
        `Waiting: ${waiting}`
      ];
      return { columns: ['Engine Status'], rows: [[lines.join('\n')]] };
    }
    
    throw new Error(`Unsupported admin command: ${cmd}`);
  }

  async close(): Promise<void> {
    this.isAcceptingQueries = false;

    if (this.deadlockDetector) {
      this.deadlockDetector.stop();
    }

    if (this.logManager) {
      await this.logManager.flush(this.logManager.currentLsn());
      await this.logManager.close();
    }

    if (this.bufferPool) {
      await this.bufferPool.flushAll();
    }

    if (this.diskManager) {
      await this.diskManager.close();
    }
  }
}
