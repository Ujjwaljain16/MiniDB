import * as fs from 'fs';
import * as path from 'path';
import { MiniDB } from '../../src/MiniDB.js';

type Row = { id: number; name: string; age: number };

function makeRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= n; i++) rows.push({ id: i, name: `u${i}`, age: 20 + (i % 40) });
  return rows;
}

describe('SQL correctness', () => {
  let tempDir: string;
  let db: MiniDB;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'sqlcorrect-'));
    db = new MiniDB(tempDir, 16);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadUsers(n: number, opts: { indexOn?: string[] } = {}): Promise<Row[]> {
    await db.execute('CREATE TABLE users (id INT, name VARCHAR(20), age INT)');
    for (const col of opts.indexOn ?? ['id']) {
      await db.execute(`CREATE INDEX idx_${col} ON users (${col})`);
    }
    const rows = makeRows(n);
    for (let i = 0; i < rows.length; i += 200) {
      const values = rows.slice(i, i + 200).map(r => `(${r.id}, '${r.name}', ${r.age})`).join(', ');
      await db.execute(`INSERT INTO users VALUES ${values}`);
    }
    return rows;
  }

  async function ids(sql: string): Promise<number[]> {
    const res = await db.execute(sql);
    return res.rows.map(r => r[0] as number).sort((a, b) => a - b);
  }

  describe('expressions', () => {
    it('evaluates AND, OR and parentheses in WHERE', async () => {
      const rows = await loadUsers(200);
      const expected = rows.filter(r => (r.id < 10 || r.id > 190) && r.age > 25).map(r => r.id);
      expect(await ids('SELECT id FROM users WHERE (id < 10 OR id > 190) AND age > 25')).toEqual(expected);
    });

    it('evaluates LIKE with % and _ and ignores case', async () => {
      const rows = await loadUsers(150, { indexOn: ['id', 'name'] });
      const like = (re: RegExp) => rows.filter(r => re.test(r.name)).map(r => r.id);
      expect(await ids("SELECT id FROM users WHERE name LIKE 'u1%'")).toEqual(like(/^u1/));
      expect(await ids("SELECT id FROM users WHERE name LIKE 'U_'")).toEqual(like(/^u.$/));
      expect(await ids("SELECT id FROM users WHERE name LIKE '%5' AND id > 50")).toEqual(rows.filter(r => /5$/.test(r.name) && r.id > 50).map(r => r.id));
      expect(await ids("SELECT id FROM users WHERE name LIKE 'u1.%'")).toEqual([]);
      const explain = await db.execute("EXPLAIN SELECT id FROM users WHERE name LIKE 'u1'");
      expect(String(explain.rows[0]![0])).not.toContain('phys_index_scan');
    });

    it('accepts negative literals and the == and <> spellings', async () => {
      const rows = await loadUsers(50);
      expect(await ids('SELECT id FROM users WHERE id > -5 AND id == 7')).toEqual([7]);
      expect(await ids('SELECT id FROM users WHERE id <> 1')).toEqual(rows.filter(r => r.id !== 1).map(r => r.id));
    });
  });

  describe('index range predicates', () => {
    const cases: Array<[string, (r: Row) => boolean]> = [
      ['id > 1995', r => r.id > 1995],
      ['id >= 1995', r => r.id >= 1995],
      ['id < 5', r => r.id < 5],
      ['id <= 5', r => r.id <= 5],
      ['id = 1000', r => r.id === 1000],
      ['1995 < id', r => 1995 < r.id],
      ['5 >= id', r => 5 >= r.id],
      ['id > 100 AND id <= 110', r => r.id > 100 && r.id <= 110],
      ['id > 10 AND id < 5', () => false],
      ['id > 2000', () => false],
      ['id != 5', r => r.id !== 5],
      ['id = 7 AND age > 20', r => r.id === 7 && r.age > 20],
    ];

    it('match a brute-force scan after ANALYZE', async () => {
      const rows = await loadUsers(2000);
      await db.execute('ANALYZE users');
      for (const [where, pred] of cases) {
        const expected = rows.filter(pred).map(r => r.id);
        expect({ where, ids: await ids(`SELECT id FROM users WHERE ${where}`) }).toEqual({ where, ids: expected });
      }
      expect(db.bufferPool.stats().pinnedPages).toBe(0);
    });

    it('use the index for a selective open range', async () => {
      await loadUsers(2000);
      await db.execute('ANALYZE users');
      const explain = await db.execute('EXPLAIN SELECT * FROM users WHERE id > 1995');
      expect(String(explain.rows[0]![0])).toContain('phys_index_scan');
    });

    it('use the index for one conjunct of an AND', async () => {
      await loadUsers(2000);
      await db.execute('ANALYZE users');
      const explain = await db.execute('EXPLAIN SELECT * FROM users WHERE id = 5 AND age > 20');
      expect(String(explain.rows[0]![0])).toContain('phys_index_scan');
    });
  });

  describe('self-joins', () => {
    const pairs = (res: { rows: unknown[][] }) =>
      res.rows.map(r => r.join('|')).sort();

    it('returns the right rows for a join on different columns', async () => {
      const rows = await loadUsers(3000);
      const started = Date.now();
      const res = await db.execute('SELECT u1.id, u2.id FROM users u1 JOIN users u2 ON u1.id = u2.age WHERE u1.id = 25');
      expect(Date.now() - started).toBeLessThan(5000);
      const expected = rows.filter(r => r.age === 25).map(r => `25|${r.id}`).sort();
      expect(expected.length).toBe(75);
      expect(pairs(res)).toEqual(expected);
    });

    it('reads the right columns when the join orderer puts the second table first', async () => {
      const rows = await loadUsers(400);
      const res = await db.execute('SELECT a.id, b.name, a.age FROM users a JOIN users b ON a.age = b.id WHERE b.id = 30');
      const expected = rows.filter(r => r.age === 30).map(r => `${r.id}|u30|30`).sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(pairs(res)).toEqual(expected);
    });

    it('applies every conjunct of an ON clause', async () => {
      const rows = await loadUsers(200);
      // Without the second conjunct this would pair each row with every row of the same age.
      const res = await db.execute('SELECT a.id, b.id FROM users a JOIN users b ON a.age = b.age AND a.id = b.id');
      expect(pairs(res)).toEqual(rows.map(r => `${r.id}|${r.id}`).sort());
    });

    it('handles three-way joins and WHERE conjuncts on several tables', async () => {
      const rows = await loadUsers(300);
      const res = await db.execute(
        'SELECT a.id, b.id, c.id FROM users a JOIN users b ON a.age = b.age JOIN users c ON c.id = b.id WHERE a.id = 7 AND b.id < 100 AND c.age = a.age');
      const a = rows.find(r => r.id === 7)!;
      const expected = rows.filter(b => b.age === a.age && b.id < 100).map(b => `7|${b.id}|${b.id}`).sort();
      expect(pairs(res)).toEqual(expected);
    });

    it('keeps table-free predicates and still filters', async () => {
      await loadUsers(50);
      const none = await db.execute('SELECT * FROM users a JOIN users b ON a.id = b.id WHERE 1 = 0');
      expect(none.rows).toEqual([]);
      const one = await db.execute('SELECT * FROM users a JOIN users b ON a.id = b.id WHERE a.id = 9 AND 1 = 1');
      expect(one.rows).toEqual([[9, 'u9', 29, 9, 'u9', 29]]);
    });
  });

  describe('INSERT', () => {
    it('places values by the named columns and fills the rest with NULL', async () => {
      await loadUsers(3);
      await db.execute("INSERT INTO users (age, id, name) VALUES (77, 100, 'zed')");
      await db.execute('INSERT INTO users (id) VALUES (200)');
      expect((await db.execute('SELECT * FROM users WHERE id = 100')).rows).toEqual([[100, 'zed', 77]]);
      expect((await db.execute('SELECT * FROM users WHERE age = 77')).rows).toEqual([[100, 'zed', 77]]);
      expect((await db.execute('SELECT * FROM users WHERE id = 200')).rows).toEqual([[200, null, null]]);
    });

    it('rejects NULL in a NOT NULL column and repeated columns', async () => {
      await db.execute('CREATE TABLE t (id INT NOT NULL, label VARCHAR(10))');
      await expect(db.execute("INSERT INTO t (label) VALUES ('x')")).rejects.toThrow(/Column 'id' cannot be NULL/);
      await expect(db.execute("INSERT INTO t VALUES (NULL, 'x')")).rejects.toThrow(/Column 'id' cannot be NULL/);
      await expect(db.execute('INSERT INTO t (id, id) VALUES (1, 2)')).rejects.toThrow(/listed more than once/);
      expect((await db.execute('SELECT * FROM t')).rows).toEqual([]);
    });
  });

  describe('DELETE', () => {
    it('deletes every matching row when an index scan drives it', async () => {
      await loadUsers(2000);
      await db.execute('ANALYZE users');
      const explain = await db.execute('EXPLAIN DELETE FROM users WHERE id > 1990');
      expect(String(explain.rows[0]![0])).toContain('phys_index_scan');

      const res = await db.execute('DELETE FROM users WHERE id > 1990');
      expect(res.rowsAffected).toBe(10);
      expect(await ids('SELECT id FROM users WHERE id > 1985')).toEqual([1986, 1987, 1988, 1989, 1990]);
      expect(await ids('SELECT id FROM users WHERE id >= 1985 AND age > 0')).toEqual([1985, 1986, 1987, 1988, 1989, 1990]);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);
    });
  });

  describe('non-unique index', () => {
    it('stays consistent with the table after deletes', async () => {
      const rows = await loadUsers(2000, { indexOn: ['id', 'age'] });
      await db.execute('DELETE FROM users WHERE id <= 700');
      await db.execute('DELETE FROM users WHERE id > 1500 AND id < 1600');
      const live = rows.filter(r => r.id > 700 && !(r.id > 1500 && r.id < 1600));

      const explain = await db.execute('EXPLAIN SELECT id FROM users WHERE age = 30');
      expect(String(explain.rows[0]![0])).toContain('idx_age');
      for (const age of [20, 30, 45, 59]) {
        expect({ age, ids: await ids(`SELECT id FROM users WHERE age = ${age}`) })
          .toEqual({ age, ids: live.filter(r => r.age === age).map(r => r.id) });
      }
      const tree = db.catalog.getTable('users' as any).indexes['idx_age' as any]!.tree;
      const leaves = (await tree.describe()).nodes.filter((n: { isLeaf: boolean }) => n.isLeaf);
      expect(leaves.reduce((n: number, l: { keys: unknown[] }) => n + l.keys.length, 0)).toBe(live.length);
    });
  });

  describe('B+ tree inspection', () => {
    it('describes the index built through SQL and leaves nothing pinned', async () => {
      await loadUsers(1500);
      const tree = db.catalog.getTable('users' as any).indexes['idx_id' as any]!.tree;
      const d = await tree.describe();
      expect(d.height).toBeGreaterThan(1);
      expect(d.nodes.filter((n: { isLeaf: boolean }) => n.isLeaf).flatMap((n: { keys: number[] }) => n.keys))
        .toEqual(Array.from({ length: 1500 }, (_, i) => i + 1));
      expect(db.bufferPool.stats().pinnedPages).toBe(0);
    });
  });

  describe('column names', () => {
    it('uses the alias, else the column name, qualified only for aliased tables', async () => {
      await loadUsers(5);
      expect((await db.execute('SELECT * FROM users')).columns).toEqual(['id', 'name', 'age']);
      expect((await db.execute('SELECT id, name AS n FROM users')).columns).toEqual(['id', 'n']);
      expect((await db.execute('SELECT u.id, u.age AS years FROM users u')).columns).toEqual(['u.id', 'years']);
      expect((await db.execute('SELECT * FROM users a JOIN users b ON a.id = b.id')).columns)
        .toEqual(['a.id', 'a.name', 'a.age', 'b.id', 'b.name', 'b.age']);
      const bStar = await db.execute('SELECT b.* FROM users a JOIN users b ON a.id = b.age');
      expect(bStar.columns).toEqual(['b.id', 'b.name', 'b.age']);
      expect((await db.execute('SELECT id FROM users LIMIT 1')).columns).toEqual(['id']);
    });
  });

  describe('EXPLAIN and plans', () => {
    const SELF_JOIN = 'SELECT u1.id, u2.id FROM users u1 JOIN users u2 ON u1.id = u2.age WHERE u1.id = 25';

    it('explains a self-join with table, index range and join condition', async () => {
      await loadUsers(300);
      const res = await db.execute(`EXPLAIN ${SELF_JOIN}`);
      const text = String(res.rows[0]![0]);
      expect(text).toContain('phys_nlj [u1.id = u2.age]');
      expect(text).toContain('phys_index_scan [users AS u1 using idx_id: id = 25]');
      expect(text).toContain('phys_filter [u1.id = 25]');
      expect(text).toContain('phys_seq_scan [users AS u2]');
      expect(text).not.toContain('rows=~0');
    });

    it('explains analyze a self-join with actual rows', async () => {
      await loadUsers(300);
      const res = await db.execute(`EXPLAIN ANALYZE ${SELF_JOIN}`);
      const text = String(res.rows[0]![0]);
      expect(text).toMatch(/phys_project \[u1\.id, u2\.id\].*actual rows=8,/);
      expect(text).toMatch(/phys_index_scan .*actual rows=1,/);
    });

    it('attaches the executed plan with actual rows to every result', async () => {
      await loadUsers(300);
      const res = await db.execute(`${SELF_JOIN} LIMIT 3`);
      expect(res.rows.length).toBe(3);
      const plan = res.plan!;
      expect(plan).toMatchObject({ kind: 'phys_limit', label: 'Limit', detail: '3', estRows: 3, actualRows: 3 });
      expect(plan.timeMs).toBeGreaterThanOrEqual(0);
      const join = plan.children[0]!.children[0]!;
      expect(join).toMatchObject({ label: 'Nested Loop Join', detail: 'u1.id = u2.age' });
      expect(join.children.map(c => c.label)).toEqual(['Filter', 'Seq Scan']);
      expect(join.children[0]!.children[0]).toMatchObject({ label: 'Index Scan', actualRows: 1 });

      const del = await db.execute('DELETE FROM users WHERE id = 1');
      expect(del.plan).toMatchObject({ label: 'Delete', detail: 'FROM users' });
      const ins = await db.execute("INSERT INTO users VALUES (1, 'u1', 21)");
      expect(ins.plan).toMatchObject({ label: 'Insert', detail: 'INTO users (1 row)', children: [] });
    });

    it('builds an estimate-only plan for the UI', async () => {
      await loadUsers(10);
      const logical = db.binder.bind({ kind: 'select', projections: [{ kind: 'star' }], from: { table: 'users' }, joins: [], limit: 2 } as any);
      const plan = db.executor.explainPlan(db.planner.plan(logical));
      expect(plan.label).toBe('Limit');
      expect(plan.actualRows).toBeUndefined();
      expect(plan.children[0]!.children[0]).toMatchObject({ label: 'Seq Scan', detail: 'users', estRows: 1000, children: [] });
    });
  });

  describe('LIMIT', () => {
    it('returns at most n rows and leaves no page pinned', async () => {
      const rows = await loadUsers(3000);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);

      const three = await db.execute('SELECT * FROM users LIMIT 3');
      expect(three.rows.length).toBe(3);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);

      const ranged = await db.execute('SELECT id FROM users WHERE id > 100 LIMIT 5');
      expect(ranged.rows.length).toBe(5);
      expect(ranged.rows.every(r => (r[0] as number) > 100)).toBe(true);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);

      const joined = await db.execute('SELECT a.id, b.id FROM users a JOIN users b ON a.age = b.age LIMIT 4');
      expect(joined.rows.length).toBe(4);
      expect(joined.rows.every(r => rows[(r[0] as number) - 1]!.age === rows[(r[1] as number) - 1]!.age)).toBe(true);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);

      expect((await db.execute('SELECT * FROM users LIMIT 0')).rows).toEqual([]);
      expect((await db.execute('SELECT * FROM users WHERE id <= 10 LIMIT 50')).rows.length).toBe(10);
      expect(db.bufferPool.stats().pinnedPages).toBe(0);
    });
  });

  describe('before ANALYZE', () => {
    it('chooses the index for an equality and returns the right rows', async () => {
      const rows = await loadUsers(300);
      const explain = await db.execute('EXPLAIN SELECT * FROM users WHERE id = 5');
      expect(String(explain.rows[0]![0])).toContain('phys_index_scan');
      expect(await ids('SELECT id FROM users WHERE id = 5')).toEqual([5]);
      expect(await ids('SELECT id FROM users WHERE id >= 290 AND age > 30'))
        .toEqual(rows.filter(r => r.id >= 290 && r.age > 30).map(r => r.id));
    });
  });

  describe('unsupported SQL fails with a clear error', () => {
    beforeEach(async () => {
      await loadUsers(5);
    });

    it.each([
      ['SELECT * FROM users ORDER BY age', /ORDER BY is not supported/],
      ['SELECT age FROM users GROUP BY age', /GROUP BY is not supported/],
      ['SELECT age FROM users GROUP BY age HAVING age > 1', /GROUP BY is not supported/],
      ['SELECT * FROM users LIMIT 2 OFFSET 1', /OFFSET is not supported/],
      ['SELECT * FROM users LIMIT 1, 2', /OFFSET is not supported/],
      ['SELECT DISTINCT age FROM users', /DISTINCT is not supported/],
      ['SELECT id FROM users UNION SELECT id FROM users', /UNION is not supported/],
      ['SELECT * FROM users a, users b', /Comma joins/],
      ['SELECT * FROM users a LEFT JOIN users b ON a.id = b.id', /LEFT JOIN is not supported/],
      ['SELECT * FROM users a RIGHT JOIN users b ON a.id = b.id', /RIGHT JOIN is not supported/],
      ['SELECT * FROM users a FULL JOIN users b ON a.id = b.id', /FULL JOIN is not supported/],
      ['SELECT * FROM users a CROSS JOIN users b', /CROSS JOIN is not supported/],
      ['SELECT * FROM users a JOIN users b USING (id)', /USING is not supported/],
      ['SELECT * FROM users a JOIN users b', /ON condition/],
      ['SELECT COUNT(*) FROM users', /Aggregate functions such as COUNT\(\) are not supported/],
      ['SELECT SUM(age) FROM users', /Aggregate functions such as SUM\(\) are not supported/],
      ['SELECT UPPER(name) FROM users', /Function calls such as UPPER\(\) are not supported/],
      ['SELECT age + 1 FROM users', /Arithmetic expressions are not supported/],
      ['SELECT * FROM users WHERE age + 1 > 3', /Arithmetic expressions are not supported/],
      ['SELECT * FROM users WHERE NOT age = 3', /NOT is not supported/],
      ['SELECT * FROM users WHERE age IN (1, 2)', /IN is not supported/],
      ['SELECT * FROM users WHERE age BETWEEN 1 AND 2', /BETWEEN is not supported/],
      ['SELECT * FROM (SELECT * FROM users)', /Subqueries are not supported/],
      ['UPDATE users SET age = 1', /UPDATE is not supported; use DELETE then INSERT/],
    ])('%s', async (sql, message) => {
      await expect(db.execute(sql)).rejects.toThrow(message);
    });
  });
});
