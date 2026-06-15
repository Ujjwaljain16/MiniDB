import { parseSQL } from '../../../src/sql/Parser';
import { Binder } from '../../../src/sql/Binder';
import { PhysicalPlanner } from '../../../src/optimizer/PhysicalPlanner';
import { explainTree } from '../../../src/optimizer/Explain';
import { Catalog } from '../../../src/catalog/Catalog';
import { JSONCatalogStorage } from '../../../src/catalog/JSONCatalogStorage';
import type { TableId } from '../../../src/common/types';
import * as os from 'os';
import * as path from 'path';

describe('PhysicalPlanner & Explain', () => {
  let catalog: Catalog;

  beforeAll(async () => {
    const storage = new JSONCatalogStorage(path.join(os.tmpdir(), `planner_test_${Date.now()}.json`));
    catalog = new Catalog(storage);
    await catalog.load();

    await catalog.createTable({
      tableId: 'users' as TableId,
      heapFile: 'u.heap',
      schema: [
        { name: 'id', type: 'INT', nullable: false },
        { name: 'name', type: 'VARCHAR', nullable: false },
        { name: 'age', type: 'INT', nullable: false }
      ],
      primaryKey: 'id',
      indexes: {
        'idx_users_id': { column: 'id', indexId: 'idx_users_id' as any, type: 'btree', indexFile: '', rootPageId: 0 }
      } as any
    });

    await catalog.createTable({
      tableId: 'orders' as TableId,
      heapFile: 'o.heap',
      schema: [
        { name: 'id', type: 'INT', nullable: false },
        { name: 'user_id', type: 'INT', nullable: false },
        { name: 'amount', type: 'INT', nullable: false }
      ],
      primaryKey: 'id',
      indexes: {}
    });

    const usersEntry = catalog.getTable('users' as any);
    usersEntry.stats = {
      rowCount: 100000,
      columnStats: {
        id: { min: 1, max: 100000, nDistinct: 100000 },
        age: { min: 18, max: 68, nDistinct: 50 }
      }
    };
    
    const ordersEntry = catalog.getTable('orders' as any);
    ordersEntry.stats = {
      rowCount: 500000,
      columnStats: {
        user_id: { min: 1, max: 100000, nDistinct: 80000 }
      }
    };
  });

  it('plans an IndexScan when using equality predicate on indexed column', () => {
    const ast = parseSQL('SELECT * FROM users WHERE id = 42');
    const binder = new Binder(catalog);
    const logicalPlan = binder.bind(ast);
    
    const planner = new PhysicalPlanner(catalog);
    const physicalPlan = planner.plan(logicalPlan);
    
    const explain = explainTree(physicalPlan);
    expect(explain).toContain('phys_index_scan');
    expect(explain).toContain('idx_users_id');
    // Equality on id (100k distinct) gives sel = 1/100k
    // rowCount = 100k * 1/100k = 1 row
    expect(explain).toContain('rows=~1');
  });

  it('plans a SeqScan when no index is available', () => {
    const ast = parseSQL('SELECT * FROM users WHERE age = 42');
    const binder = new Binder(catalog);
    const logicalPlan = binder.bind(ast);
    
    const planner = new PhysicalPlanner(catalog);
    const physicalPlan = planner.plan(logicalPlan);
    
    const explain = explainTree(physicalPlan);
    expect(explain).toContain('phys_seq_scan [users]');
    expect(explain).not.toContain('phys_index_scan');
  });

  it('plans a nested loop join', () => {
    const ast = parseSQL('SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id');
    const binder = new Binder(catalog);
    const logicalPlan = binder.bind(ast);
    
    const planner = new PhysicalPlanner(catalog);
    const physicalPlan = planner.plan(logicalPlan);
    
    const explain = explainTree(physicalPlan);
    expect(explain).toContain('phys_nlj');
  });

  it('can explain an analyze statement logic flow', () => {
    const ast = parseSQL('ANALYZE users');
    expect(ast.kind).toBe('analyze');
    if (ast.kind === 'analyze') {
      expect(ast.table).toBe('users');
    }
  });
});
