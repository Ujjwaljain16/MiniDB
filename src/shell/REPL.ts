// src/shell/REPL.ts — Phase 9
// Interactive readline REPL: "minidb> " prompt, multi-line until ';'.

import * as readline from 'readline';
import { MiniDB } from '../MiniDB.js';

const db = new MiniDB('data');

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: 'minidb> ',
});

async function main(): Promise<void> {
  await db.open().catch(() => {
    // In development, MiniDB.open() throws NYI — continue anyway for shell scaffolding
  });

  console.log('MiniDB interactive shell. Type SQL terminated with ; to execute. .quit to exit.');
  rl.prompt();

  let buffer = '';

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed === '.quit' || trimmed === '.exit') {
      console.log('Bye.');
      process.exit(0);
    }
    buffer += ' ' + trimmed;
    if (buffer.trim().endsWith(';')) {
      const sql = buffer.trim().slice(0, -1).trim(); // strip trailing semicolon
      buffer = '';
      try {
        const result = await db.execute(sql);
        console.log(formatResult(result));
      } catch (err) {
        console.error('[ERROR]', err instanceof Error ? err.message : err);
      }
    }
    rl.prompt();
  });
}

function formatResult(result: Awaited<ReturnType<MiniDB['execute']>>): string {
  const { columns, rows, rowsAffected, executionMs } = result;
  if (rows.length === 0 && rowsAffected !== undefined) {
    return `${rowsAffected} row(s) affected. (${executionMs?.toFixed(2) ?? '?'}ms)`;
  }
  const header = columns.join(' | ');
  const divider = columns.map(c => '-'.repeat(c.length)).join('-+-');
  const body = rows.map(r => r.map(v => String(v ?? 'NULL')).join(' | ')).join('\n');
  return [header, divider, body, `\n(${rows.length} row(s)) (${executionMs?.toFixed(2) ?? '?'}ms)`].join('\n');
}

main().catch(console.error);
