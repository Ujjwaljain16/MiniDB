// ─── src/common/utils.ts ──────────────────────────────────────────────────────
// Cross-cutting utility functions used by multiple layers.
// No business logic here — only pure helpers.

import type { IBufferPool } from './interfaces.js';
import type { PageId } from './types.js';

// ─── Buffer Pool guard ────────────────────────────────────────────────────────

/**
 * Execute `fn` with a pinned buffer pool page, guaranteeing unpin on exit.
 *
 * This is the MANDATORY pattern for all buffer pool accesses.
 * Missing an unpin causes BufferPoolExhaustedError within POOL_SIZE operations.
 *
 * Usage:
 *   const rid = await withPage(pool, pageId, false, async (buf) => {
 *     return readFromPage(buf);
 *   });
 *
 * @param isDirty  Pass `true` if `fn` modified the page (marks frame dirty).
 */
export async function withPage<T>(
  pool: IBufferPool,
  pageId: PageId,
  isDirty: boolean,
  fn: (buf: Buffer) => Promise<T>,
): Promise<T> {
  const buf = await pool.fetchPage(pageId);
  try {
    return await fn(buf);
  } finally {
    pool.unpinPage(pageId, isDirty);
  }
}

/**
 * Execute `fn` with a freshly allocated pinned page, guaranteeing unpin on exit.
 * The page is zero-filled on creation.
 *
 * @param isDirty  Almost always `true` since you'll write to the new page.
 */
export async function withNewPage<T>(
  pool: IBufferPool,
  isDirty: boolean,
  fn: (pageId: PageId, buf: Buffer) => Promise<T>,
): Promise<T> {
  const [pageId, buf] = await pool.newPage();
  try {
    return await fn(pageId, buf);
  } finally {
    pool.unpinPage(pageId, isDirty);
  }
}

// ─── Comparison helpers ───────────────────────────────────────────────────────

import type { ColValue } from './types.js';

/**
 * Compare two column values with the natural ordering used by the B+ tree.
 * Returns negative, 0, or positive (like Array.prototype.sort comparator).
 *
 * null is treated as less than all non-null values (SQL NULL semantics).
 */
export function compareColValues(a: ColValue, b: ColValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const ba = BigInt(a as string | number | bigint);
    const bb = BigInt(b as string | number | bigint);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b);
  }

  // String comparison (VARCHAR)
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ─── Logging utilities ────────────────────────────────────────────────────────

/** Structured log levels. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Minimal structured logger used inside MiniDB internals. */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** Default console-based logger. Replace with a proper logger in production. */
export class ConsoleLogger implements Logger {
  constructor(private readonly prefix: string = 'minidb') {}

  private log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    const ts   = new Date().toISOString();
    const base = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${this.prefix}] ${msg}`;
    if (ctx && Object.keys(ctx).length > 0) {
      console[level === 'debug' ? 'log' : level](`${base} ${JSON.stringify(ctx)}`);
    } else {
      console[level === 'debug' ? 'log' : level](base);
    }
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.log('debug', msg, ctx); }
  info (msg: string, ctx?: Record<string, unknown>): void { this.log('info',  msg, ctx); }
  warn (msg: string, ctx?: Record<string, unknown>): void { this.log('warn',  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.log('error', msg, ctx); }
}

/** No-op logger for tests that don't care about log output. */
export class SilentLogger implements Logger {
  debug(_msg: string, _ctx?: Record<string, unknown>): void {}
  info (_msg: string, _ctx?: Record<string, unknown>): void {}
  warn (_msg: string, _ctx?: Record<string, unknown>): void {}
  error(_msg: string, _ctx?: Record<string, unknown>): void {}
}

// ─── Numeric helpers ──────────────────────────────────────────────────────────

/** Integer ceiling division: Math.ceil(a / b) without floating point. */
export function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** Clamp `value` to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Monotonic timestamp in milliseconds (for LRU-K history). */
export function now(): number {
  return Date.now();
}

// ─── Iterator helpers ─────────────────────────────────────────────────────────

/**
 * Collect all items from an AsyncIterableIterator into an array.
 * Used in tests and CLI output formatting.
 */
export async function collectAsync<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

/**
 * Take up to `n` items from an AsyncIterableIterator.
 * Useful for LIMIT clause implementation.
 */
export async function takeAsync<T>(iter: AsyncIterableIterator<T>, n: number): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
    if (results.length >= n) break;
  }
  return results;
}
