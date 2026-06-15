// ─── src/common/types.ts ──────────────────────────────────────────────────────
// All branded/opaque primitive types and core data structures used across
// every layer of MiniDB. Import from here — never define types locally.
//
// Branded types pattern: `T & { readonly __brand: 'T' }` makes the type
// nominally typed at compile time while remaining a plain number/string at
// runtime — zero overhead, maximum safety.

// ─── Branded ID types ─────────────────────────────────────────────────────────

/** Identifies a 4KB page within a single database file. */
export type PageId = number & { readonly __brand: 'PageId' };

/** Identifies a slot within a slotted page. */
export type SlotId = number & { readonly __brand: 'SlotId' };

/** Log Sequence Number — monotonically increasing, globally unique per WAL file. */
export type LSN = number & { readonly __brand: 'LSN' };

/** Transaction ID — monotonically increasing, globally unique per database session. */
export type TxnId = number & { readonly __brand: 'TxnId' };

/** Logical table identifier (matches the key in catalog.json). */
export type TableId = string & { readonly __brand: 'TableId' };

/** Logical index identifier (namespaced as `<tableId>.<indexName>`). */
export type IndexId = string & { readonly __brand: 'IndexId' };

// ─── Sentinel values ──────────────────────────────────────────────────────────

/** Sentinel PageId used to represent "no page" (e.g. null parent or next-leaf pointer). */
export const NULL_PAGE_ID = -1 as PageId;

/** Sentinel LSN used before any log record has been written to a page. */
export const INVALID_LSN = -1 as LSN;

/** Sentinel TxnId for system operations that run outside any transaction. */
export const SYSTEM_TXN_ID = 0 as TxnId;

// ─── Record identifier ────────────────────────────────────────────────────────

/**
 * Record ID — the stable, physical address of a tuple within a heap file.
 * Stored in B+ tree leaf nodes as the value pointer.
 * Size: 6 bytes (4B pageId + 2B slotId).
 */
export interface RID {
  readonly pageId: PageId;
  readonly slotId: SlotId;
}

/** Create a RID from raw numeric components. */
export function makeRID(pageId: number, slotId: number): RID {
  return { pageId: pageId as PageId, slotId: slotId as SlotId };
}

/** Serialize a RID to a 6-byte Buffer for storage in index nodes. */
export function encodeRID(rid: RID, buf: Buffer, offset: number): void {
  buf.writeUInt32LE(rid.pageId, offset);
  buf.writeUInt16LE(rid.slotId, offset + 4);
}

/** Deserialize a RID from a 6-byte Buffer region. */
export function decodeRID(buf: Buffer, offset: number): RID {
  return makeRID(buf.readUInt32LE(offset), buf.readUInt16LE(offset + 4));
}

/** Human-readable RID string for logging/debugging. */
export function ridStr(rid: RID): string {
  return `(p${rid.pageId},s${rid.slotId})`;
}

// ─── Column / Schema types ────────────────────────────────────────────────────

/** Supported column data types. Extend here if new types are added. */
export type ColType = 'INT' | 'BIGINT' | 'FLOAT' | 'VARCHAR' | 'BOOL';

/**
 * A column value as held in memory during query execution.
 * null represents SQL NULL.
 */
export type ColValue = number | bigint | string | boolean | null;

/** A tuple is an ordered array of column values, aligned with a Schema. */
export type Tuple = ColValue[];

/** Definition of a single column in a table schema. */
export interface ColumnDef {
  readonly name:     string;
  readonly type:     ColType;
  /** Only meaningful for VARCHAR — max byte length. */
  readonly maxLen?:  number;
  readonly nullable: boolean;
}

/** Ordered list of column definitions describing a table's structure. */
export type Schema = ReadonlyArray<ColumnDef>;

// ─── Query result ─────────────────────────────────────────────────────────────

/** What every `MiniDB.execute()` call returns to the caller. */
export interface ResultSet {
  /** Output column names, in projection order. */
  readonly columns:      string[];
  /** Result rows. Each row aligns with `columns` by index. */
  readonly rows:         Tuple[];
  /** Set for DML operations (INSERT/DELETE/UPDATE). */
  readonly rowsAffected?: number;
  /** Wall-clock execution time in milliseconds. */
  readonly executionMs?:  number;
}

// ─── Serialization sizes (bytes per type on disk) ─────────────────────────────

export const COL_FIXED_SIZE: Record<Exclude<ColType, 'VARCHAR'>, number> = {
  INT:    4,
  BIGINT: 8,
  FLOAT:  8,
  BOOL:   1,
};

/**
 * Compute the serialized byte length of a single column value.
 * VARCHAR is 2-byte length prefix + content bytes (UTF-8).
 */
export function colByteSize(def: ColumnDef, value?: ColValue): number {
  if (def.type === 'VARCHAR') {
    if (value == null) return 2; // null → length=0
    const byteLen = Buffer.byteLength(String(value), 'utf8');
    return 2 + byteLen;
  }
  return COL_FIXED_SIZE[def.type];
}

/**
 * Compute the maximum possible serialized byte length of a tuple.
 * Used to check whether a tuple can fit in a page.
 */
export function maxTupleSize(schema: Schema): number {
  return schema.reduce((acc, col) => {
    if (col.type === 'VARCHAR') return acc + 2 + (col.maxLen ?? 255);
    return acc + COL_FIXED_SIZE[col.type];
  }, 0);
}
