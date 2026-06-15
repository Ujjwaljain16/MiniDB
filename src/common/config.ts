// ─── src/common/config.ts ─────────────────────────────────────────────────────
// Single source of truth for all database constants.
// Change here, propagates everywhere — never scatter magic numbers.

/** Size of every on-disk page in bytes. Matches OS page size to minimize partial reads. */
export const PAGE_SIZE = 4096 as const;

/** Number of frames in the buffer pool. 64 × 4 KB = 256 KB in-memory working set. */
export const POOL_SIZE = 64 as const;

/** K in LRU-K replacement policy. K=2 distinguishes single-access from hot pages. */
export const LRUK_K = 2 as const;

/**
 * Batch size for vectorized execution (Track A extension).
 * 1024 rows per batch — fits comfortably in L1 cache for a 4-column INT table.
 */
export const BATCH_SIZE = 1024 as const;

/** Approximate rows per heap page, used by the cost model. */
export const ROWS_PER_PAGE = 100 as const;

/**
 * IO cost weights — cost model uses page counts × these multipliers.
 * IO-dominant at demo scale; CPU cost is ignored.
 */
export const PAGE_READ_COST  = 1.0 as const;
export const PAGE_WRITE_COST = 1.2 as const;

/** Assumed B+ tree height at demo scale (≤ 1M rows → height ≤ 3). */
export const BTREE_HEIGHT_ESTIMATE = 3 as const;

/** How often (ms) the deadlock detector runs its wait-for-graph DFS. */
export const DEADLOCK_CHECK_INTERVAL_MS = 100 as const;

/** Filename for the persistent catalog stored in the data directory. */
export const CATALOG_FILENAME = 'catalog.json' as const;

/** Filename for the WAL log. */
export const WAL_FILENAME = 'wal.log' as const;

/** Fill factor for B+ tree bulk load. Leaves are filled to 70% to leave room for future inserts. */
export const BTREE_FILL_FACTOR = 0.7 as const;

/** Tombstone marker for deleted slot offsets in the slotted page slot directory. */
export const SLOT_TOMBSTONE = 0xffff as const;

/** Byte offset of the slot directory start within a page header. */
export const PAGE_HEADER_SIZE = 24 as const;

/** Bytes per slot-directory entry: offset(2B) + length(2B). */
export const SLOT_ENTRY_SIZE = 4 as const;
