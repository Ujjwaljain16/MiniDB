import { parseSQL } from '../../../src/sql/Parser';

describe('Parser', () => {
  it('parses SELECT with JOIN and WHERE', () => {
    const sql = `
      SELECT u.name, o.amount 
      FROM users u 
      INNER JOIN orders o ON u.id = o.user_id 
      WHERE o.amount > 100 
      LIMIT 10
    `;
    const ast = parseSQL(sql);
    expect(ast).toEqual({
      kind: 'select',
      projections: [
        { kind: 'col', tableAlias: 'u', column: 'name', alias: undefined },
        { kind: 'col', tableAlias: 'o', column: 'amount', alias: undefined }
      ],
      from: { table: 'users', alias: 'u' },
      joins: [
        {
          table: 'orders',
          alias: 'o',
          on: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column_ref', table: 'u', column: 'id' },
            right: { kind: 'column_ref', table: 'o', column: 'user_id' }
          }
        }
      ],
      where: {
        kind: 'binary',
        op: '>',
        left: { kind: 'column_ref', table: 'o', column: 'amount' },
        right: { kind: 'literal', value: 100 }
      },
      limit: 10
    });
  });

  it('parses INSERT', () => {
    const sql = `INSERT INTO users (id, name) VALUES (1, 'alice')`;
    const ast = parseSQL(sql);
    expect(ast).toEqual({
      kind: 'insert',
      table: 'users',
      columns: ['id', 'name'],
      values: [
        [
          { kind: 'literal', value: 1 },
          { kind: 'literal', value: 'alice' }
        ]
      ]
    });
  });

  it('parses CREATE TABLE', () => {
    const sql = `CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, age INT)`;
    const ast = parseSQL(sql);
    expect(ast).toEqual({
      kind: 'create_table',
      table: 'users',
      columns: [
        { name: 'id', type: 'INT', nullable: false, maxLen: undefined, primaryKey: true },
        { name: 'name', type: 'VARCHAR', nullable: false, maxLen: 100, primaryKey: false },
        { name: 'age', type: 'INT', nullable: true, maxLen: undefined, primaryKey: false }
      ]
    });
  });
});
