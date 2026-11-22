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
    catalog = new Catalog(storage, {} as any, {} as any);
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

  it('uses the index for one conjunct of an AND and keeps the full predicate on top', () => {
    const logicalPlan = new Binder(catalog).bind(parseSQL('SELECT * FROM users WHERE age > 20 AND id = 42'));
    const physicalPlan = new PhysicalPlanner(catalog).plan(logicalPlan) as any;

    expect(physicalPlan.kind).toBe('phys_project');
    const filter = physicalPlan.child;
    expect(filter.kind).toBe('phys_filter');
    expect(filter.predicate.kind).toBe('bound_logical');
    expect(filter.child.kind).toBe('phys_index_scan');
    expect(filter.child.lowKey).toBe(42);
    expect(filter.child.highKey).toBe(42);
  });

  it('intersects range conjuncts on the indexed column', () => {
    const logicalPlan = new Binder(catalog).bind(parseSQL('SELECT * FROM users WHERE id > 10 AND 20 >= id AND id >= 12'));
    const scan = (new PhysicalPlanner(catalog).plan(logicalPlan) as any).child.child;
    expect(scan.kind).toBe('phys_index_scan');
    expect(scan.lowKey).toBe(12);
    expect(scan.highKey).toBe(20);
  });

  it('never uses the index for != or LIKE', () => {
    for (const where of ['id != 42', 'id <> 42', "name LIKE 'a%'"]) {
      const logicalPlan = new Binder(catalog).bind(parseSQL(`SELECT * FROM users WHERE ${where}`));
      expect(explainTree(new PhysicalPlanner(catalog).plan(logicalPlan))).not.toContain('phys_index_scan');
    }
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

  it('resolves join columns to their offset in the joined row without touching the logical plan', () => {
    const logicalPlan = new Binder(catalog).bind(
      parseSQL('SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = 7'));
    const before = JSON.stringify(logicalPlan);
    const project = new PhysicalPlanner(catalog).plan(logicalPlan) as any;
    expect(JSON.stringify(logicalPlan)).toBe(before);

    const join = project.child;
    expect(join.kind).toBe('phys_nlj');
    // The WHERE conjunct is pushed into the users side, not left above the join.
    const usersSide = [join.left, join.right].find((n: any) => n.kind === 'phys_filter');
    expect(usersSide.child.kind).toBe('phys_index_scan');

    const usersFirst = join.left === usersSide;
    const usersOffset = usersFirst ? 0 : 3;
    const ordersOffset = usersFirst ? 3 : 0;
    expect(project.projections.map((p: any) => p.columnIndex)).toEqual([usersOffset + 1, ordersOffset + 2]);
    const cols = [join.condition.left, join.condition.right];
    expect(cols.find((c: any) => c.columnName === 'id').columnIndex).toBe(usersOffset + 0);
    expect(cols.find((c: any) => c.columnName === 'user_id').columnIndex).toBe(ordersOffset + 1);
  });

  it('can explain an analyze statement logic flow', () => {
    const ast = parseSQL('ANALYZE users');
    expect(ast.kind).toBe('analyze');
    if (ast.kind === 'analyze') {
      expect(ast.table).toBe('users');
    }
  });
});
