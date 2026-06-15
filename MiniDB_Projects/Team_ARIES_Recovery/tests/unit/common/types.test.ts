// tests/unit/common/types.test.ts
// Day 0 smoke tests — verify branded types, RID encode/decode, and
// utility functions compile and behave correctly at runtime.
// These tests have ZERO dependency on unimplemented modules.

import {
  makeRID,
  encodeRID,
  decodeRID,
  ridStr,
  colByteSize,
  maxTupleSize,
  NULL_PAGE_ID,
  INVALID_LSN,
  SYSTEM_TXN_ID,
} from '../../../src/common/types';

import {
  assert,
  MiniDBAssertionError,
  DiskError,
  BufferPoolExhaustedError,
  DeadlockError,
} from '../../../src/common/errors';

import {
  compareColValues,
  ConsoleLogger,
  SilentLogger,
  ceilDiv,
  clamp,
  withPage,
} from '../../../src/common/utils';

import {
  PAGE_SIZE,
  POOL_SIZE,
  LRUK_K,
  BATCH_SIZE,
  PAGE_HEADER_SIZE,
  SLOT_ENTRY_SIZE,
  SLOT_TOMBSTONE,
} from '../../../src/common/config';

import { LOCK_COMPAT, LockMode } from '../../../src/common/interfaces';

// ─── Sentinel values ──────────────────────────────────────────────────────────

describe('Sentinel values', () => {
  test('NULL_PAGE_ID is -1', () => expect(NULL_PAGE_ID).toBe(-1));
  test('INVALID_LSN is -1',  () => expect(INVALID_LSN).toBe(-1));
  test('SYSTEM_TXN_ID is 0', () => expect(SYSTEM_TXN_ID).toBe(0));
});

// ─── Config constants ─────────────────────────────────────────────────────────

describe('Config constants', () => {
  test('PAGE_SIZE is 4096',    () => expect(PAGE_SIZE).toBe(4096));
  test('POOL_SIZE is 64',      () => expect(POOL_SIZE).toBe(64));
  test('LRUK_K is 2',         () => expect(LRUK_K).toBe(2));
  test('BATCH_SIZE is 1024',   () => expect(BATCH_SIZE).toBe(1024));
  test('PAGE_HEADER_SIZE 24',  () => expect(PAGE_HEADER_SIZE).toBe(24));
  test('SLOT_ENTRY_SIZE 4',    () => expect(SLOT_ENTRY_SIZE).toBe(4));
  test('SLOT_TOMBSTONE 0xFFFF',() => expect(SLOT_TOMBSTONE).toBe(0xffff));
});

// ─── RID encode / decode ──────────────────────────────────────────────────────

describe('RID encode/decode', () => {
  test('roundtrip: page=0, slot=0', () => {
    const rid = makeRID(0, 0);
    const buf = Buffer.alloc(6);
    encodeRID(rid, buf, 0);
    const decoded = decodeRID(buf, 0);
    expect(decoded.pageId).toBe(0);
    expect(decoded.slotId).toBe(0);
  });

  test('roundtrip: page=1000000, slot=65535', () => {
    const rid = makeRID(1_000_000, 65_535);
    const buf = Buffer.alloc(6);
    encodeRID(rid, buf, 0);
    const decoded = decodeRID(buf, 0);
    expect(decoded.pageId).toBe(1_000_000);
    expect(decoded.slotId).toBe(65_535);
  });

  test('encodes at non-zero offset', () => {
    const rid = makeRID(42, 7);
    const buf = Buffer.alloc(16);
    encodeRID(rid, buf, 4);          // start at byte 4
    const decoded = decodeRID(buf, 4);
    expect(decoded.pageId).toBe(42);
    expect(decoded.slotId).toBe(7);
    // bytes 0-3 should be untouched
    expect(buf.readUInt32LE(0)).toBe(0);
  });

  test('ridStr format', () => {
    const rid = makeRID(5, 3);
    expect(ridStr(rid)).toBe('(p5,s3)');
  });
});

// ─── Column / Schema utilities ────────────────────────────────────────────────

describe('colByteSize', () => {
  test('INT → 4', () => expect(colByteSize({ name:'x',type:'INT',nullable:false })).toBe(4));
  test('BIGINT → 8', () => expect(colByteSize({ name:'x',type:'BIGINT',nullable:false })).toBe(8));
  test('FLOAT → 8', () => expect(colByteSize({ name:'x',type:'FLOAT',nullable:false })).toBe(8));
  test('BOOL → 1', () => expect(colByteSize({ name:'x',type:'BOOL',nullable:false })).toBe(1));
  test('VARCHAR null → 2', () => expect(colByteSize({ name:'x',type:'VARCHAR',nullable:true }, null)).toBe(2));
  test('VARCHAR "hello" → 7', () => {
    // 2-byte prefix + 5 bytes UTF-8
    expect(colByteSize({ name:'x',type:'VARCHAR',nullable:false }, 'hello')).toBe(7);
  });
});

describe('maxTupleSize', () => {
  test('schema with INT+VARCHAR(64)+BOOL', () => {
    const schema = [
      { name:'id', type:'INT' as const, nullable:false },
      { name:'name', type:'VARCHAR' as const, maxLen:64, nullable:true },
      { name:'active', type:'BOOL' as const, nullable:false },
    ];
    // INT=4, VARCHAR=2+64=66, BOOL=1 → 71
    expect(maxTupleSize(schema)).toBe(71);
  });
});

// ─── compareColValues ─────────────────────────────────────────────────────────

describe('compareColValues', () => {
  test('null < number', () => expect(compareColValues(null, 1)).toBeLessThan(0));
  test('number > null', () => expect(compareColValues(1, null)).toBeGreaterThan(0));
  test('null == null',   () => expect(compareColValues(null, null)).toBe(0));
  test('1 < 2',         () => expect(compareColValues(1, 2)).toBeLessThan(0));
  test('2 > 1',         () => expect(compareColValues(2, 1)).toBeGreaterThan(0));
  test('5 == 5',        () => expect(compareColValues(5, 5)).toBe(0));
  test('"a" < "b"',     () => expect(compareColValues('a', 'b')).toBeLessThan(0));
  test('"z" > "a"',     () => expect(compareColValues('z', 'a')).toBeGreaterThan(0));
  test('"x" == "x"',    () => expect(compareColValues('x', 'x')).toBe(0));
  test('false < true',  () => expect(compareColValues(false, true)).toBeLessThan(0));
  test('bigint compare', () => {
    expect(compareColValues(BigInt(100), BigInt(200))).toBeLessThan(0);
    expect(compareColValues(BigInt(999), BigInt(1))).toBeGreaterThan(0);
  });
});

// ─── Error hierarchy ──────────────────────────────────────────────────────────

describe('Error hierarchy', () => {
  test('DiskError has kind=DiskError', () => {
    const e = new DiskError('read', '/tmp/x.db', 'ENOENT');
    expect(e.kind).toBe('DiskError');
    expect(e.message).toContain('read');
    expect(e.context['path']).toBe('/tmp/x.db');
  });

  test('BufferPoolExhaustedError captures requested/poolSize', () => {
    const e = new BufferPoolExhaustedError(99 as any, 64);
    expect(e.kind).toBe('BufferPoolExhaustedError');
    expect(e.context['poolSize']).toBe(64);
  });

  test('DeadlockError captures cycle', () => {
    const e = new DeadlockError(3 as any, [1, 2, 3] as any);
    expect(e.kind).toBe('DeadlockError');
    expect(e.context['cycle']).toEqual([1, 2, 3]);
  });

  test('assert passes when true', () => {
    expect(() => assert(true, 'ok')).not.toThrow();
  });

  test('assert throws MiniDBAssertionError when false', () => {
    expect(() => assert(false, 'boom')).toThrow(MiniDBAssertionError);
  });

  test('instanceof check works', () => {
    const e = new DiskError('write', 'f');
    expect(e instanceof Error).toBe(true);
    expect(e instanceof DiskError).toBe(true);
  });
});

// ─── Numeric helpers ──────────────────────────────────────────────────────────

describe('ceilDiv', () => {
  test('10 / 3 = 4', () => expect(ceilDiv(10, 3)).toBe(4));
  test('9 / 3 = 3',  () => expect(ceilDiv(9, 3)).toBe(3));
  test('1 / 5 = 1',  () => expect(ceilDiv(1, 5)).toBe(1));
});

describe('clamp', () => {
  test('clamp(5, 0, 10) = 5',  () => expect(clamp(5, 0, 10)).toBe(5));
  test('clamp(-1, 0, 10) = 0', () => expect(clamp(-1, 0, 10)).toBe(0));
  test('clamp(20, 0, 10) = 10',() => expect(clamp(20, 0, 10)).toBe(10));
});

// ─── Lock compatibility matrix ────────────────────────────────────────────────

describe('LOCK_COMPAT matrix', () => {
  // Access enum values via namespace — destructuring const enums is illegal in TypeScript.
  // Expectation: LOCK_COMPAT[granted][requested]
  const cases: Array<[LockMode, LockMode, boolean]> = [
    [LockMode.S,  LockMode.S,  true],  [LockMode.S,  LockMode.X,  false],
    [LockMode.X,  LockMode.S,  false], [LockMode.X,  LockMode.X,  false],
  ];

  test.each(cases)('LOCK_COMPAT[%i][%i] = %s', (granted, requested, expected) => {
    expect(LOCK_COMPAT[granted]?.[requested]).toBe(expected);
  });

  test('matrix is 2×2', () => {
    expect(LOCK_COMPAT.length).toBe(2);
    for (const row of LOCK_COMPAT) {
      expect(row.length).toBe(2);
    }
  });

  test('S=0, X=1 numeric values are stable', () => {
    expect(LockMode.S).toBe(0);
    expect(LockMode.X).toBe(1);
  });
});

// ─── SilentLogger (used in tests) ────────────────────────────────────────────

describe('SilentLogger', () => {
  test('does not throw', () => {
    const log = new SilentLogger();
    expect(() => {
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    }).not.toThrow();
  });
});
