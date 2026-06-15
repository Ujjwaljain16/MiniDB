// ─── src/common/errors.ts ─────────────────────────────────────────────────────
// Typed error hierarchy for MiniDB.
//
// Design rationale:
//  - Every subsystem throws a specific subclass — callers can discriminate
//    with `instanceof` or the `kind` discriminant without string-matching.
//  - All errors carry a `context` object for structured logging.
//  - Never throw plain `Error` from MiniDB internals — always use these classes.

import type { PageId, TxnId, RID, TableId, LSN } from './types.js';

// ─── Base ─────────────────────────────────────────────────────────────────────

export abstract class MiniDBError extends Error {
  abstract readonly kind: string;
  constructor(
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    // Restore prototype chain (required when extending Error in TypeScript).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Storage layer ────────────────────────────────────────────────────────────

/** Disk I/O operation failed. */
export class DiskError extends MiniDBError {
  override readonly kind = 'DiskError' as const;
  constructor(op: string, path: string, cause?: unknown) {
    super(`Disk ${op} failed on "${path}"`, { op, path, cause: String(cause) });
  }
}

/** All buffer pool frames are pinned — caller forgot to unpin. */
export class BufferPoolExhaustedError extends MiniDBError {
  override readonly kind = 'BufferPoolExhaustedError' as const;
  constructor(requested: PageId, poolSize: number) {
    super(`Buffer pool exhausted: all ${poolSize} frames pinned. Cannot fetch page ${requested}.`, {
      requested,
      poolSize,
    });
  }
}

/** Page was requested with a page ID that does not exist on disk. */
export class InvalidPageError extends MiniDBError {
  override readonly kind = 'InvalidPageError' as const;
  constructor(pageId: PageId) {
    super(`Page ${pageId} does not exist on disk.`, { pageId });
  }
}

/** Attempt to write to a page not in the buffer pool (coding bug). */
export class PageNotPinnedError extends MiniDBError {
  override readonly kind = 'PageNotPinnedError' as const;
  constructor(pageId: PageId) {
    super(`Page ${pageId} is not currently pinned in the buffer pool.`, { pageId });
  }
}

/** Slot ID is out of range or tombstoned. */
export class InvalidSlotError extends MiniDBError {
  override readonly kind = 'InvalidSlotError' as const;
  constructor(rid: RID) {
    super(`Slot (page=${rid.pageId}, slot=${rid.slotId}) is invalid or tombstoned.`, {
      pageId: rid.pageId,
      slotId: rid.slotId,
    });
  }
}

// ─── B+ Tree ──────────────────────────────────────────────────────────────────

/** Key not found during a B+ tree search. */
export class KeyNotFoundError extends MiniDBError {
  override readonly kind = 'KeyNotFoundError' as const;
  constructor(key: unknown, indexId: string) {
    super(`Key "${key}" not found in index "${indexId}".`, { key, indexId });
  }
}

/** Duplicate key inserted into a unique index. */
export class DuplicateKeyError extends MiniDBError {
  override readonly kind = 'DuplicateKeyError' as const;
  constructor(key: unknown, indexId: string) {
    super(`Duplicate key "${key}" in unique index "${indexId}".`, { key, indexId });
  }
}

// ─── SQL / Binder ─────────────────────────────────────────────────────────────

/** SQL text could not be parsed. */
export class ParseError extends MiniDBError {
  override readonly kind = 'ParseError' as const;
  constructor(sql: string, detail: string) {
    super(`Parse error: ${detail}`, { sql: sql.slice(0, 200), detail });
  }
}

/** Name resolution failed during binding. */
export class BindError extends MiniDBError {
  override readonly kind = 'BindError' as const;
  constructor(name: string, reason: string) {
    super(`Bind error for "${name}": ${reason}`, { name, reason });
  }
}

/** Type mismatch detected during binding or execution. */
export class TypeError extends MiniDBError {
  override readonly kind = 'TypeError' as const;
  constructor(expected: string, got: string, context?: string) {
    super(`Type error${context ? ` in ${context}` : ''}: expected ${expected}, got ${got}`, {
      expected,
      got,
      context,
    });
  }
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** Table does not exist in the catalog. */
export class TableNotFoundError extends MiniDBError {
  override readonly kind = 'TableNotFoundError' as const;
  constructor(tableId: TableId) {
    super(`Table "${tableId}" does not exist.`, { tableId });
  }
}

/** Table already exists in the catalog (CREATE TABLE conflict). */
export class TableAlreadyExistsError extends MiniDBError {
  override readonly kind = 'TableAlreadyExistsError' as const;
  constructor(tableId: TableId) {
    super(`Table "${tableId}" already exists.`, { tableId });
  }
}

/** Index does not exist on the requested table. */
export class IndexNotFoundError extends MiniDBError {
  override readonly kind = 'IndexNotFoundError' as const;
  constructor(indexId: string, tableId: TableId) {
    super(`Index "${indexId}" does not exist on table "${tableId}".`, { indexId, tableId });
  }
}

// ─── Transaction / Concurrency ────────────────────────────────────────────────

/** Transaction ID is not active (already committed or aborted). */
export class InvalidTransactionError extends MiniDBError {
  override readonly kind = 'InvalidTransactionError' as const;
  constructor(txnId: TxnId) {
    super(`Transaction ${txnId} is not active.`, { txnId });
  }
}

/**
 * Deadlock detected — this transaction was chosen as the victim and aborted.
 * The client must retry after catching this.
 */
export class DeadlockError extends MiniDBError {
  override readonly kind = 'DeadlockError' as const;
  constructor(victimTxnId: TxnId, cycle: TxnId[]) {
    super(
      `Deadlock detected. Transaction ${victimTxnId} aborted as victim. Cycle: [${cycle.join(' → ')}].`,
      { victimTxnId, cycle },
    );
  }
}

/** Lock acquisition timed out (future use — currently we wait forever). */
export class LockTimeoutError extends MiniDBError {
  override readonly kind = 'LockTimeoutError' as const;
  constructor(txnId: TxnId, key: string, timeoutMs: number) {
    super(`Transaction ${txnId} timed out waiting for lock on "${key}" after ${timeoutMs}ms.`, {
      txnId,
      key,
      timeoutMs,
    });
  }
}

// ─── Recovery ─────────────────────────────────────────────────────────────────

/** WAL log is corrupted or truncated. */
export class LogCorruptError extends MiniDBError {
  override readonly kind = 'LogCorruptError' as const;
  constructor(lsn: LSN, detail: string) {
    super(`WAL corruption at LSN ${lsn}: ${detail}`, { lsn, detail });
  }
}

/** Recovery failed because an expected log record is missing. */
export class RecoveryError extends MiniDBError {
  override readonly kind = 'RecoveryError' as const;
  constructor(phase: 'analysis' | 'redo' | 'undo', detail: string) {
    super(`Recovery failed in ${phase} pass: ${detail}`, { phase, detail });
  }
}

// ─── Runtime guard ────────────────────────────────────────────────────────────

/**
 * Assert a condition is true, throwing a descriptive error on failure.
 * Use instead of bare `if (!x) throw` to get consistent error formatting.
 */
export function assert(condition: boolean, message: string, context?: Record<string, unknown>): asserts condition {
  if (!condition) {
    throw new MiniDBAssertionError(message, context);
  }
}

export class MiniDBAssertionError extends MiniDBError {
  override readonly kind = 'AssertionError' as const;
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(`Assertion failed: ${message}`, context);
  }
}
