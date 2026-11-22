// Runs the built browser bundle under Node. Deliberately imports no fs: the bundle
// must work on its own, with every Node builtin replaced by a throwing stub.
import { MiniDB } from '../dist-browser/minidb.mjs';
import sizes from '../dist-browser/minidb.size.json' with { type: 'json' };

const db = await MiniDB.inMemory({ poolSize: 16 });
const counts = { hit: 0, miss: 0, new: 0, evict: 0, flush: 0 };
db.bufferPool.onPageEvent = e => { counts[e.type]++; };

await db.execute('CREATE TABLE users (id INT, name VARCHAR, age INT)');
for (let i = 1; i <= 100; i++) {
  await db.execute(`INSERT INTO users VALUES (${i}, 'user${i}', ${20 + (i % 40)})`);
}
const all = await db.execute('SELECT * FROM users');
const one = await db.execute('SELECT name FROM users WHERE id = 42');
await db.close();

if (all.rows.length !== 100) throw new Error(`expected 100 rows, got ${all.rows.length}`);
if (one.rows[0]?.[0] !== 'user42') throw new Error(`point lookup returned ${JSON.stringify(one.rows)}`);

console.log(`rows: ${all.rows.length}`);
console.log(`page events: ${JSON.stringify(counts)}`);
console.log(`bundle: ${(sizes.bytes / 1024).toFixed(1)} KB raw, ${(sizes.gzipBytes / 1024).toFixed(1)} KB gzip`);
