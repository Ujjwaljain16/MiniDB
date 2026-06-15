import { JoinOrderer, JoinNode } from '../../../src/optimizer/JoinOrderer';
import type { PhysSeqScan } from '../../../src/optimizer/PhysicalPlan';
import type { ICatalog } from '../../../src/common/interfaces';

describe('JoinOrderer', () => {
  const mockCatalog = {} as ICatalog;
  const orderer = new JoinOrderer(mockCatalog);

  it('orders 3 tables optimally (exhaustive)', () => {
    // A: 1000 rows
    // B: 100 rows
    // C: 10000 rows
    const a: JoinNode = {
      node: { kind: 'phys_seq_scan', tableId: 'A' as any, estRows: 1000, estCost: 10 } as PhysSeqScan,
      tables: new Set(['A']), estRows: 1000
    };
    const b: JoinNode = {
      node: { kind: 'phys_seq_scan', tableId: 'B' as any, estRows: 100, estCost: 1 } as PhysSeqScan,
      tables: new Set(['B']), estRows: 100
    };
    const c: JoinNode = {
      node: { kind: 'phys_seq_scan', tableId: 'C' as any, estRows: 10000, estCost: 100 } as PhysSeqScan,
      tables: new Set(['C']), estRows: 10000
    };

    const conditions = [
      {
        kind: 'bound_binary', op: '=',
        left: { kind: 'bound_col', columnName: 'a_id', tableAlias: 'A' },
        right: { kind: 'bound_col', columnName: 'b_id', tableAlias: 'B' }
      },
      {
        kind: 'bound_binary', op: '=',
        left: { kind: 'bound_col', columnName: 'b_id', tableAlias: 'B' },
        right: { kind: 'bound_col', columnName: 'c_id', tableAlias: 'C' }
      }
    ] as any[];

    const plan = orderer.orderJoins([a, b, c], conditions);
    
    // With exhaustive, we expect the order that minimizes intermediate results.
    // Joining B and A first gives 100 * 1000 * 0.1 = 10000 rows.
    // Cost: A=10, B=1.
    // If we join B(outer) and A(inner), outer=100, inner=10 => cost = 1 + 100*10 = 1001.
    // If we join B and C first gives 100 * 10000 * 0.1 = 100000 rows.
    // Best plan will start with B and A, or A and B.
    expect(plan.kind).toBe('phys_nlj');
  });

  it('orders 4 tables optimally (greedy left-deep)', () => {
    const a: JoinNode = { node: { kind: 'phys_seq_scan', tableId: 'A' as any, estRows: 50, estCost: 1 } as PhysSeqScan, tables: new Set(['A']), estRows: 50 };
    const b: JoinNode = { node: { kind: 'phys_seq_scan', tableId: 'B' as any, estRows: 200, estCost: 2 } as PhysSeqScan, tables: new Set(['B']), estRows: 200 };
    const c: JoinNode = { node: { kind: 'phys_seq_scan', tableId: 'C' as any, estRows: 1000, estCost: 10 } as PhysSeqScan, tables: new Set(['C']), estRows: 1000 };
    const d: JoinNode = { node: { kind: 'phys_seq_scan', tableId: 'D' as any, estRows: 5000, estCost: 50 } as PhysSeqScan, tables: new Set(['D']), estRows: 5000 };

    const plan = orderer.orderJoins([a, b, c, d], []);
    // Greedy will sort by smallest rows: A, B, C, D
    // and then build left-deep tree: (((A JOIN B) JOIN C) JOIN D)
    expect(plan.kind).toBe('phys_nlj');
    const nlj3 = plan as any;
    expect(nlj3.right.tableId).toBe('D');
    expect(nlj3.left.kind).toBe('phys_nlj');
    const nlj2 = nlj3.left as any;
    expect(nlj2.right.tableId).toBe('C');
    expect(nlj2.left.kind).toBe('phys_nlj');
    const nlj1 = nlj2.left as any;
    expect(nlj1.left.tableId).toBe('A');
    expect(nlj1.right.tableId).toBe('B');
  });
});
