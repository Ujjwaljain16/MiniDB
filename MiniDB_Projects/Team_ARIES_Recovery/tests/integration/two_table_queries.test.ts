import { MiniDB } from '../../src/MiniDB.js';
import type { PlanInfo } from '../../src/common/types.js';

const labels = (p: PlanInfo): string[] => [p.label, ...p.children.flatMap(labels)];

describe('queries across two tables', () => {
  let db: MiniDB;
  const users: [number, string, number][] = [];
  const orders: [number, number, number][] = [];

  beforeAll(async () => {
    db = await MiniDB.inMemory({ poolSize: 8 });
    await db.execute('CREATE TABLE users (id INT, name VARCHAR(16), age INT)');
    await db.execute('CREATE INDEX idx_users_id ON users (id)');
    await db.execute('CREATE TABLE orders (id INT, user_id INT, amount INT)');
    await db.execute('CREATE INDEX idx_orders_user ON orders (user_id)');
    for (let i = 1; i <= 200; i++) users.push([i, `u${i}`, 20 + (i % 30)]);
    for (let i = 1; i <= 300; i++) orders.push([i, 1 + ((i * 7) % 200), i * 3]);
    // Interleave inserts so both tables' pages are mixed in the one data file.
    for (let i = 0; i < 300; i++) {
      if (i < users.length) await db.execute(`INSERT INTO users VALUES (${users[i]![0]}, '${users[i]![1]}', ${users[i]![2]})`);
      await db.execute(`INSERT INTO orders VALUES (${orders[i]!.join(', ')})`);
    }
    await db.execute('ANALYZE users');
    await db.execute('ANALYZE orders');
  });

  afterAll(async () => {
    await db.close();
  });

  it('keeps each table to its own rows', async () => {
    const u = await db.execute('SELECT * FROM users');
    const o = await db.execute('SELECT * FROM orders');
    expect(u.rows).toHaveLength(200);
    expect(o.rows).toHaveLength(300);
    expect(u.columns).toEqual(['id', 'name', 'age']);
  });

  it('joins two tables with a filter on one side', async () => {
    const res = await db.execute('SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = 15');
    const expected = orders.filter((o) => o[1] === 15).map((o) => ['u15', o[2]]);
    expect(res.rows.sort()).toEqual(expected.sort());
    expect(expected.length).toBeGreaterThan(0);
    expect(labels(res.plan!)).toContain('Nested Loop Join');
  });

  it('joins two tables without a filter', async () => {
    const res = await db.execute('SELECT o.id, u.age FROM orders o JOIN users u ON o.user_id = u.id');
    const ageOf = new Map(users.map((u) => [u[0], u[2]]));
    const expected = orders.map((o) => [o[0], ageOf.get(o[1])]);
    expect(res.rows.sort()).toEqual(expected.sort());
  });

  it('applies every ON condition', async () => {
    const res = await db.execute('SELECT o.id FROM users u JOIN orders o ON u.id = o.user_id AND o.amount > 600');
    const expected = orders.filter((o) => o[2] > 600).map((o) => [o[0]]);
    expect(res.rows.sort()).toEqual(expected.sort());
  });

  it('returns a structured plan for EXPLAIN', async () => {
    const res = await db.execute('EXPLAIN SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id WHERE o.user_id = 3');
    expect(res.plan).toBeDefined();
    expect(labels(res.plan!)).toEqual(expect.arrayContaining(['Nested Loop Join']));
    expect(res.plan!.actualRows).toBeUndefined();

    const analyzed = await db.execute('EXPLAIN ANALYZE SELECT * FROM users WHERE id = 42');
    // 200 rows fit in two pages, so a seq scan is the cheaper plan here.
    expect(labels(analyzed.plan!)).toContain('Seq Scan');
    expect(analyzed.plan!.actualRows).toBe(1);
  });

  it('describes an index without touching the buffer pool', async () => {
    const before = { stats: db.bufferPool.stats(), frames: db.bufferPool.snapshot() };
    const events: unknown[] = [];
    (db.bufferPool as any).onPageEvent = (e: unknown) => events.push(e);
    const tree = await db.catalog.getTable('users' as any).indexes['idx_users_id' as any]!.tree.describe();
    (db.bufferPool as any).onPageEvent = null;

    const leafKeys = tree.nodes.filter((n: any) => n.isLeaf).flatMap((n: any) => n.keys);
    expect(leafKeys).toHaveLength(200);
    expect(events).toHaveLength(0);
    expect(db.bufferPool.stats()).toEqual(before.stats);
    expect(db.bufferPool.snapshot()).toEqual(before.frames);
  });
});
