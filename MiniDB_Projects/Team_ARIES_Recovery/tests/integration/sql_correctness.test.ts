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
