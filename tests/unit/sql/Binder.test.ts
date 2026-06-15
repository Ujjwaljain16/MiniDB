import { parseSQL } from '../../../src/sql/Parser';
import { Binder, BindError, TypeError } from '../../../src/sql/Binder';
import { Catalog } from '../../../src/catalog/Catalog';
import { JSONCatalogStorage } from '../../../src/catalog/JSONCatalogStorage';
import type { TableId } from '../../../src/common/types';
import * as os from 'os';
import * as path from 'path';

describe('Binder', () => {
  let catalog: Catalog;

  beforeAll(async () => {
    const storage = new JSONCatalogStorage(path.join(os.tmpdir(), `binder_test_${Date.now()}.json`));
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
      indexes: {}
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
  });

  it('throws BindError for unknown table', () => {
    const ast = parseSQL('SELECT * FROM does_not_exist');
    const binder = new Binder(catalog);
    expect(() => binder.bind(ast)).toThrow(BindError);
    expect(() => binder.bind(ast)).toThrow("Table 'does_not_exist' not found");
  });

  it('throws BindError for ambiguous column', () => {
    // Both users and orders have an 'id' column
    const ast = parseSQL('SELECT id FROM users JOIN orders ON users.id = orders.user_id');
    const binder = new Binder(catalog);
    expect(() => binder.bind(ast)).toThrow(BindError);
    expect(() => binder.bind(ast)).toThrow("Column 'id' is ambiguous");
  });

  it('throws TypeError for mismatched types', () => {
    // age is INT, 'hello' is VARCHAR
    const ast = parseSQL("SELECT name FROM users WHERE age > 'hello'");
    const binder = new Binder(catalog);
    expect(() => binder.bind(ast)).toThrow(TypeError);
    expect(() => binder.bind(ast)).toThrow("Cannot compare INT and VARCHAR");
  });

  it('round-trips full valid SELECT query to Logical Plan', () => {
    const sql = "SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE o.amount > 100";
    const ast = parseSQL(sql);
    const binder = new Binder(catalog);
    const plan = binder.bind(ast);

    // Filter node
    expect(plan.kind).toBe('project');
    if (plan.kind !== 'project') return;
    
    expect(plan.projections.length).toBe(2);
    expect(plan.projections[0]!.kind).toBe('bound_col');
    
    const filter = plan.child;
    expect(filter.kind).toBe('filter');
    if (filter.kind !== 'filter') return;
    
    expect(filter.predicate.kind).toBe('bound_binary');
    
    const join = filter.child;
    expect(join.kind).toBe('join');
  });
});
