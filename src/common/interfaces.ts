// ─── src/common/interfaces.ts ─────────────────────────────────────────────────
// DAY 0 CONTRACT FILE — The single source of truth for all cross-layer interfaces.
//
// Every engineer codes AGAINST these interfaces, not against concrete classes.
// This file must compile cleanly before any implementation begins.
//
// Layer dependency order (top = depends on nothing):
//   types.ts → interfaces.ts → storage/ → index/ → catalog/ → sql/ → optimizer/ → execution/
//                                                             ↘ concurrency/ ↗
//                                                             ↘ recovery/   ↗

import type {
  PageId,
  SlotId,
  LSN,
  TxnId,
  TableId,
  IndexId,
  RID,
  ColValue,
  Tuple,
  Schema,
  ResultSet,
  ColumnDef,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/** Low-level page statistics reported by the buffer pool. */
export interface BufferPoolStats {
  hits:       number;
  misses:     number;
  evictions:  number;
  dirtyPages: number;
  pinnedPages: number;
  hitRatio:   number;   // hits / (hits + misses), 0–1
}

/**
 * IBufferPool — the central cache between disk I/O and all upper layers.
 *
 * Contract:
 *  - Every fetchPage() increments pin count. Caller MUST call unpinPage() exactly once.
 *  - isDirty=true on unpinPage() marks frame for eventual write-back.
 *  - Eviction enforces WAL rule: log flush for pageLsn happens before disk write.
 *  - newPage() allocates a fresh zeroed page on disk and pins it.
 */
export interface IBufferPool {
  /**
   * Fetch a page into a buffer frame. Pins the frame (pin count++).
   * If already in pool, records an access in LRU-K history.
   * If not in pool, evicts a victim frame (flushing log + data if dirty) and loads from disk.
   *
   * @returns The Buffer containing the raw page bytes. Callers must NOT hold this
   *          reference past their own unpinPage() call — the frame may be reused.
   */
  fetchPage(pageId: PageId): Promise<Buffer>;

  /**
   * Allocate a new zeroed page on disk and load it into a pinned frame.
   * @returns [new page ID, pinned buffer]. Caller must call unpinPage() when done.
   */
  newPage(): Promise<[PageId, Buffer]>;

  /**
   * Release a page pin. isDirty=true marks the frame as needing write-back.
   * This MUST be called after every fetchPage() / newPage(), even on error paths.
   */
  unpinPage(pageId: PageId, isDirty: boolean): void;

  /**
   * Force a specific page to disk immediately, regardless of pin count.
   * Used during checkpoint and shutdown.
   */
  flushPage(pageId: PageId): Promise<void>;

  /** Flush all dirty frames to disk. Called during checkpoint and orderly shutdown. */
  flushAll(): Promise<void>;

  /** Set the page LSN recorded in the frame metadata (not in the page itself). */
  setPageLsn(pageId: PageId, lsn: LSN): void;

  /** Return current buffer pool performance counters. */
  stats(): BufferPoolStats;
}

/**
 * IHeapFile — manages a single table's heap-organized storage file.
 *
 * All operations go through the buffer pool. The caller (executor) is
 * responsible for acquiring locks before calling these methods.
 */
export interface IHeapFile {
  /**
   * Serialize and insert a tuple into the best available heap page.
   * @returns The RID where the tuple was stored.
   */
  insertTuple(tuple: Tuple, schema: Schema): Promise<RID>;

  /**
   * Tombstone the slot for the given RID.
   * Does NOT reclaim space immediately — compaction is deferred.
   */
  deleteTuple(rid: RID): Promise<void>;

  /**
   * Fetch and deserialize the tuple at the given RID.
   * @returns null if the slot is tombstoned (deleted).
   */
  getTuple(rid: RID, schema: Schema): Promise<Tuple | null>;

  /**
   * Update a tuple in-place. If new data is same size, overwrites.
   * If different size, deletes + re-inserts and returns new RID.
   */
  updateTuple(rid: RID, newTuple: Tuple, schema: Schema): Promise<RID>;

  /**
   * Sequential scan of all live (non-tombstoned) tuples.
   * Yields [rid, tuple] pairs in page-order.
   */
  scan(schema: Schema): AsyncIterableIterator<[RID, Tuple]>;

  /** Total number of pages in this heap file (including FSM metadata page). */
  pageCount(): number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDEX LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * IBPlusTree — the B+ tree index interface.
 *
 * Every node is a 4KB page in the buffer pool.
 * Callers must ensure they hold appropriate locks before calling insert/delete.
 */
export interface IBPlusTree {
  /**
   * Point lookup. Returns the RID stored at `key`, or null if not found.
   * Read-only; does not acquire any locks internally.
   */
  search(key: ColValue): Promise<RID | null>;

  /**
   * Range scan. Yields all RIDs where `low <= key <= high` in ascending key order.
   * Uses the leaf-level linked list for efficient traversal.
   */
  searchRange(low: ColValue, high: ColValue): AsyncIterableIterator<RID>;

  /**
   * Insert a (key, RID) pair. Splits nodes as needed.
   * Caller is responsible for logging before calling this.
   */
  insert(key: ColValue, rid: RID): Promise<void>;

  /**
   * Remove the entry for `key`. Merges/borrows from siblings as needed.
   * Caller is responsible for logging before calling this.
   */
  delete(key: ColValue): Promise<void>;

  /**
   * Bulk-load the tree from a pre-sorted array.
   * Fills leaves at BTREE_FILL_FACTOR (70%) and constructs internal nodes bottom-up.
   * Significantly faster than sequential inserts for initial population.
   * @param entries Must be sorted by key ascending. Duplicate keys are rejected.
   */
  bulkLoad(entries: ReadonlyArray<[ColValue, RID]>): Promise<void>;

  /** Current root page ID (changes after root split/merge). */
  rootPageId(): PageId;

  /** Height of the tree (1 = root is a leaf). */
  height(): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/** Per-column statistics used by the cost model. */
export interface ColumnStats {
  nDistinct: number;
  min:       ColValue;
  max:       ColValue;
}

/** Table-level statistics maintained by ANALYZE. */
export interface TableStats {
  rowCount:    number;
  columnStats: Record<string, ColumnStats>;
}

/** Describes a B+ tree index on a single column of a table. */
export interface IndexDef {
  readonly indexId:    IndexId;
  readonly type:       'btree';
  readonly column:     string;
  readonly indexFile:  string;   // relative path under data dir
  rootPageId:          PageId;   // mutable — changes on root split/merge
}

/** Full catalog entry for a single table. */
export interface CatalogEntry {
  readonly tableId:    TableId;
  readonly heapFile:   string;   // relative path under data dir
  readonly schema:     Schema;
  readonly primaryKey: string;
  readonly indexes:    Record<IndexId, IndexDef>;
  stats:               TableStats; // mutable — updated by ANALYZE
}

/**
 * ICatalog — persistent metadata store.
 *
 * All DDL mutations are immediately flushed to catalog.json to survive crashes.
 */
export interface ICatalog {
  /** Load catalog from disk. Must be called once at startup. */
  load(): Promise<void>;

  /** Persist the current in-memory state to disk. */
  flush(): Promise<void>;

  /** List all known table IDs. */
  tables(): TableId[];

  /** Retrieve a table entry. Throws TableNotFoundError if absent. */
  getTable(tableId: TableId): CatalogEntry;

  /** Create a new table. Throws TableAlreadyExistsError if name is taken. */
  createTable(entry: Omit<CatalogEntry, 'stats'>): Promise<void>;

  /** Remove a table and all its indexes. Throws TableNotFoundError if absent. */
  dropTable(tableId: TableId): Promise<void>;

  /** Register a new index on an existing table. */
  createIndex(tableId: TableId, def: IndexDef): Promise<void>;

  /** Update table statistics (called by ANALYZE). */
  updateStats(tableId: TableId, stats: TableStats): Promise<void>;

  /** Update root page ID for an index (called after root split/merge). */
  updateIndexRoot(tableId: TableId, indexId: IndexId, rootPageId: PageId): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENCY LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lock granularity and mode — matches the 4×4 compatibility matrix.
 *
 * NOTE: Regular enum (not const enum) so it works correctly across module
 * boundaries with ts-jest, esbuild, and isolatedModules builds.
 */
export enum LockMode {
  S  = 0, // Shared — read lock on the resource
  X  = 1, // Exclusive — write lock on the resource
}

/**
 * Lock compatibility matrix.
 * `LOCK_COMPAT[grantedMode][requestedMode] === true` means compatible (no conflict).
 *
 *          S    X
 * S      [  ✓    ✗ ]
 * X      [  ✗    ✗ ]
 */
export const LOCK_COMPAT: ReadonlyArray<ReadonlyArray<boolean>> = [
  /* S  */ [true,  false],
  /* X  */ [false, false],
] as const;

/**
 * Current phase of a transaction under strict 2PL.
 * Regular enum — see LockMode note above.
 */
export enum TxnState {
  GROWING   = 'GROWING',    // can acquire locks; this is the only state we allow new acquisitions
  WAITING   = 'WAITING',    // blocked waiting for a lock
  COMMITTED = 'COMMITTED',
  ABORTED   = 'ABORTED',
}

/** Full runtime state of an active transaction. */
export interface Transaction {
  readonly txnId: TxnId;
  state:          TxnState;
  /** LSN of the BEGIN record in the WAL. Used by recovery analysis pass. */
  beginLsn:       LSN;
  /**
   * LSN of the most recent log record written by this transaction.
   * Forms a backward chain: record.prevLsn → record.prevLsn → ... → beginLsn.
   * Used by the undo pass to walk the transaction's log in reverse.
   */
  prevLsn:        LSN;
}

/**
 * ILockManager — table-level and row-level locking with strict 2PL.
 *
 * Acquire MUST block (return a pending Promise) when a conflicting lock is held.
 * releaseAll() MUST be called only at commit or abort — not mid-transaction.
 */
export interface ILockManager {
  /**
   * Acquire a lock on a specific row (RID).
   * Blocks until compatible with all currently granted locks on that row.
   */
  acquireRowLock(txnId: TxnId, rid: RID, mode: LockMode): Promise<void>;

  /**
   * Release all locks held by this transaction.
   * Called ONLY at commit() or abort(). Never mid-transaction.
   * Wakes up all waiting transactions that become compatible after release.
   */
  releaseAll(txnId: TxnId): void;

  /**
   * Build the wait-for graph for deadlock detection.
   * Returns a map: txnId → [txnIds that txnId is waiting for].
   */
  buildWaitForGraph(): Map<TxnId, TxnId[]>;
}

/**
 * ITxnManager — BEGIN / COMMIT / ABORT lifecycle.
 *
 * Owns the TxnId counter and the active transaction table.
 * Coordinates with LockManager (release) and LogManager (WAL flush on commit).
 */
export interface ITxnManager {
  /** Start a new transaction and write a BEGIN log record. */
  begin(): Promise<Transaction>;

  /**
   * Commit transaction: write COMMIT log record, flush WAL to that LSN,
   * then release all locks (strict 2PL).
   */
  commit(txnId: TxnId): Promise<void>;

  /**
   * Abort transaction: undo all changes (walk prevLsn chain, apply beforeImages),
   * write ABORT log record, release all locks.
   */
  abort(txnId: TxnId): Promise<void>;

  /** Retrieve an active transaction by ID. Returns undefined if not active. */
  getTransaction(txnId: TxnId): Transaction | undefined;

  /** All currently active (uncommitted/unaborted) transactions. Used by recovery. */
  activeTransactions(): ReadonlyMap<TxnId, Transaction>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY / WAL LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/** All possible WAL record types. */
export type LogType =
  | 'BEGIN'
  | 'INSERT'
  | 'DELETE'
  | 'UPDATE'
  | 'COMMIT'
  | 'ABORT'
  | 'CHECKPOINT';

/**
 * A single WAL log record.
 *
 * Disk layout (variable-length):
 *   [lsn:8][prevLsn:8][txnId:4][type:1][tableIdLen:1][tableId:N]
 *   [ridPresent:1][pageId:4][slotId:2]
 *   [beforeLen:4][before:N][afterLen:4][after:N]
 *   [totalLen:4]  ← trailing length for backward scan
 */
export interface LogRecord {
  readonly lsn:          LSN;
  readonly prevLsn:      LSN;
  readonly txnId:        TxnId;
  readonly type:         LogType;
  readonly tableId?:     TableId;
  readonly rid?:         RID;
  /** Raw serialized bytes of the tuple BEFORE modification. Present on DELETE/UPDATE. */
  readonly beforeImage?: Buffer;
  /** Raw serialized bytes of the tuple AFTER modification. Present on INSERT/UPDATE. */
  readonly afterImage?:  Buffer;
}

/**
 * ILogManager — sequential, append-only WAL.
 *
 * WAL rules enforced:
 *   1. Undo rule (steal): log record flushed BEFORE dirty page written to disk.
 *   2. Redo rule (no-force): COMMIT log record flushed; data pages need not be.
 */
export interface ILogManager {
  /**
   * Append a log record. Assigns a new LSN.
   * Record is buffered in memory until flush() is called.
   * @returns The LSN assigned to this record.
   */
  append(record: Omit<LogRecord, 'lsn'>): Promise<LSN>;

  /**
   * Flush all buffered records up to and including `upToLsn` to disk.
   * After this returns, those records are durable.
   * Called:
   *   - before evicting a dirty page (undo rule)
   *   - after writing a COMMIT record (redo rule)
   */
  flush(upToLsn: LSN): Promise<void>;

  /**
   * Scan log records forward starting from `fromLsn`.
   * Used by recovery (redo pass) and SHOW WAL.
   */
  iterator(fromLsn: LSN): AsyncIterableIterator<LogRecord>;

  /** The LSN of the most recently appended record. */
  currentLsn(): LSN;

  /** Flush everything and close the log file. Called at orderly shutdown. */
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION LAYER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ExecContext — the execution context threaded through every operator call.
 *
 * Contains all services an operator might need. Passed at open() time so
 * operators can access the transaction, lock manager, buffer pool, etc.
 * without constructor injection.
 */
export interface ExecContext {
  readonly txn:         Transaction;
  readonly txnManager:  ITxnManager;
  readonly lockManager: ILockManager;
  readonly catalog:     ICatalog;
  readonly bufferPool:  IBufferPool;
  readonly logManager:  ILogManager;
}

/**
 * IOperator — the Volcano iterator model interface.
 *
 * Every physical operator (SeqScan, IndexScan, Filter, NLJ, etc.) implements this.
 * Execution: root.open(ctx) → loop root.next() until null → root.close().
 */
export interface IOperator {
  /**
   * Initialize the operator. Called once before any next() calls.
   * Must call open() recursively on children.
   */
  open(ctx: ExecContext): Promise<void>;

  /**
   * Return the next tuple, or null when exhausted.
   * Each call may block on I/O (buffer pool fetch, index scan).
   */
  next(): Promise<Tuple | null>;

  /**
   * Release all resources held by this operator and its children.
   * Must be idempotent and called even if next() threw.
   */
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VECTORIZED EXECUTION LAYER (Extension Track A)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * IVecOperator — the vectorized (columnar) operator interface.
 *
 * Unlike IOperator which returns one tuple per call, IVecOperator returns
 * a DataChunk of up to BATCH_SIZE tuples in columnar layout.
 * The selection vector inside DataChunk tracks which rows survive filters.
 */
export interface IVecOperator {
  open(ctx: ExecContext): Promise<void>;

  /**
   * Return the next batch of tuples, or null when exhausted.
   * Batch size ≤ BATCH_SIZE. The DataChunk's selectionVector indicates live rows.
   */
  nextBatch(): Promise<IDataChunk | null>;

  close(): Promise<void>;
}

/** A columnar batch of rows produced by vectorized operators. */
export interface IDataChunk {
  /** Number of rows in this batch (may be < BATCH_SIZE for final batch). */
  numRows: number;
  /**
   * One TypedArray per column. INT → Int32Array, BIGINT → BigInt64Array,
   * FLOAT → Float64Array, BOOL → Uint8Array.
   * Indexed as `columns[colIdx][rowIdx]`.
   */
  columns: ArrayBufferView[];
  /**
   * Boolean mask: selectionVector[rowIdx] = 1 means row is alive.
   * Filter operators set bits to 0 rather than compacting.
   */
  selectionVector: Uint8Array;
  /** Schema describing the column types in order. */
  schema: Schema;
}
