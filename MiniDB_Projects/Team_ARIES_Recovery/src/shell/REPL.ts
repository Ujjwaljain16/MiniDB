import * as readline from 'readline';
import { MiniDB } from '../MiniDB.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const db = new MiniDB('data');

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: 'minidb> ',
});

const BANNER = `================================================
 MiniDB v1.0
 Advanced Database Management System Capstone

 Storage: Heap + B+Tree
 Cache: LRU-K Buffer Pool
 Execution:
   - Volcano
   - Vectorized
 Transactions:
   - Strict 2PL
 Recovery:
   - WAL + ARIES-lite
================================================

Database recovered successfully.
Ready.`;

const HELP = `MiniDB commands:

SQL:
 CREATE TABLE
 INSERT
 SELECT
 DELETE
 EXPLAIN
 ANALYZE

Internal:
 SHOW BUFFER_POOL
 SHOW WAL
 SHOW TRANSACTIONS

System:
 \\help
 \\exit
 \\stats
 \\benchmark [name]`;

async function main(): Promise<void> {
  try {
    await db.open();
    console.log(BANNER);
  } catch (err: any) {
    console.error('Failed to boot MiniDB:', err.message);
    process.exit(1);
  }

  rl.prompt();

  let buffer = '';

  for await (const line of rl) {
    const trimmed = line.trim();
    
    // System Commands
    if (trimmed === '\\exit' || trimmed === '.quit' || trimmed === '.exit') {
      console.log('Shutting down safely...');
      await db.close();
      console.log('Bye.');
      process.exit(0);
    } else if (trimmed === '\\help') {
      console.log(HELP);
      rl.prompt();
      continue;
    } else if (trimmed === '\\stats') {
      try {
        const result = await db.execute('SHOW BUFFER_POOL');
        const hitsRow = result.rows.find(r => r[0] === 'hits');
        const missesRow = result.rows.find(r => r[0] === 'misses');
        const hitRatioRow = result.rows.find(r => r[0] === 'hitRatio');
        
        const hits = hitsRow ? hitsRow[1] : 0;
        const misses = missesRow ? missesRow[1] : 0;
        const ratio = hitRatioRow ? hitRatioRow[1] : 0;

        const walResult = await db.execute('SHOW WAL');
        const records = walResult.rows.length;

        console.log(`Buffer Pool:`);
        console.log(` Hits: ${hits}`);
        console.log(` Misses: ${misses}`);
        console.log(` Hit Rate: ${(Number(ratio) * 100).toFixed(1)}%`);
        console.log(`\nWAL:`);
        console.log(` Recent Records: ${records}`); // Approx stat based on SHOW WAL limit
      } catch (err: any) {
        console.error('[ERROR]', err.message);
      }
      rl.prompt();
      continue;
    } else if (trimmed.startsWith('\\benchmark')) {
      const parts = trimmed.split(' ');
      const name = parts[1] || 'all';
      console.log(`Running benchmark: ${name}...\n`);
      try {
        const { stdout, stderr } = await execAsync(`npm run bench ${name !== 'all' ? name : ''}`);
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
      } catch (err: any) {
        console.log(err.stdout);
        console.error('[ERROR running benchmark]', err.message);
      }
      rl.prompt();
      continue;
    }

    buffer += ' ' + trimmed;
    
    const parts = buffer.split(';');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const sql = part.trim();
      if (sql.length > 0) {
        try {
          const start = performance.now();
          const result = await db.execute(sql);
          const end = performance.now();
          const ms = end - start;
          console.log(formatResult(result, ms));
        } catch (err: any) {
          console.error('[ERROR]', err.stack || err.message);
          buffer = '';
          break;
        }
      }
    }
    rl.prompt();
  }
}

function formatResult(result: any, executionMs: number): string {
  const { columns, rows, rowsAffected } = result;
  if (rows.length === 0 && rowsAffected !== undefined) {
    return `${rowsAffected} row(s) affected. (${executionMs.toFixed(2)}ms)`;
  }
  if (columns.length === 0 && rows.length === 0) {
    return `OK. (${executionMs.toFixed(2)}ms)`;
  }
  const header = columns.join(' | ');
  const divider = columns.map((c: string) => '-'.repeat(c.length)).join('-+-');
  const body = rows.map((r: any[]) => r.map(v => String(v ?? 'NULL')).join(' | ')).join('\n');
  return [header, divider, body, `\n(${rows.length} row(s)) (${executionMs.toFixed(2)}ms)`].join('\n');
}

main().catch(console.error);
