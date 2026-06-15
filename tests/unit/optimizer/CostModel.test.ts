import { estimateSelectivity, seqScanCost, indexScanCost } from '../../../src/optimizer/CostModel';
import type { BoundExpression, BoundColumnRef, BoundLiteral } from '../../../src/sql/LogicalPlan';
import type { TableStats } from '../../../src/common/interfaces';

describe('CostModel', () => {
  const stats: TableStats = {
    rowCount: 10000,
    columnStats: {
      id: { min: 1, max: 10000, nDistinct: 10000 },
      age: { min: 18, max: 68, nDistinct: 50 },
      name: { min: 'A', max: 'Z', nDistinct: 5000 }
    }
  };

  it('estimates sequential scan cost correctly', () => {
    expect(seqScanCost(1000)).toBe(10); // 1000/100 * 1
    expect(seqScanCost(1050)).toBe(11);
  });

  it('estimates index scan cost correctly', () => {
    // btreeHeight=3 + sel*rowCount*1
    expect(indexScanCost(10000, 0.01)).toBe(3 + 100); 
  });

  it('estimates equality selectivity using nDistinct', () => {
    const expr: BoundExpression = {
      kind: 'bound_binary',
      op: '=',
      left: { kind: 'bound_col', columnName: 'age', columnIndex: 1, tableId: 'users' as any, type: 'INT' },
      right: { kind: 'bound_literal', value: 25, type: 'INT' }
    };
    expect(estimateSelectivity(expr, stats)).toBe(1 / 50);
  });

  it('estimates range selectivity (<)', () => {
    const expr: BoundExpression = {
      kind: 'bound_binary',
      op: '<',
      left: { kind: 'bound_col', columnName: 'age', columnIndex: 1, tableId: 'users' as any, type: 'INT' },
      right: { kind: 'bound_literal', value: 28, type: 'INT' } // 28 - 18 / 50 = 10 / 50 = 0.2
    };
    expect(estimateSelectivity(expr, stats)).toBe(0.2);
  });

  it('estimates range selectivity (>=)', () => {
    const expr: BoundExpression = {
      kind: 'bound_binary',
      op: '>=',
      left: { kind: 'bound_col', columnName: 'age', columnIndex: 1, tableId: 'users' as any, type: 'INT' },
      right: { kind: 'bound_literal', value: 58, type: 'INT' } // 68 - 58 / 50 = 10 / 50 = 0.2
    };
    expect(estimateSelectivity(expr, stats)).toBe(0.2);
  });

  it('returns default selectivity for LIKE', () => {
    const expr: BoundExpression = {
      kind: 'bound_binary',
      op: 'LIKE',
      left: { kind: 'bound_col', columnName: 'name', columnIndex: 2, tableId: 'users' as any, type: 'VARCHAR' },
      right: { kind: 'bound_literal', value: 'J%', type: 'VARCHAR' }
    };
    expect(estimateSelectivity(expr, stats)).toBe(0.1);
  });

  it('handles AND logical expressions', () => {
    const expr: BoundExpression = {
      kind: 'bound_logical',
      op: 'AND',
      left: {
        kind: 'bound_binary', op: '=',
        left: { kind: 'bound_col', columnName: 'age', columnIndex: 1, tableId: 'users' as any, type: 'INT' },
        right: { kind: 'bound_literal', value: 25, type: 'INT' }
      },
      right: {
        kind: 'bound_binary', op: '<',
        left: { kind: 'bound_col', columnName: 'age', columnIndex: 1, tableId: 'users' as any, type: 'INT' },
        right: { kind: 'bound_literal', value: 28, type: 'INT' }
      }
    };
    // = is 1/50 = 0.02, < is 0.2
    // AND = 0.02 * 0.2 = 0.004
    expect(estimateSelectivity(expr, stats)).toBeCloseTo(0.004);
  });
});
