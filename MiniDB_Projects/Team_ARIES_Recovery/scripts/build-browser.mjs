// Bundles MiniDB into one browser ESM file: dist-browser/minidb.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const outfile = 'dist-browser/minidb.mjs';
const stub = './scripts/browser/node-stub.js';
const nodeBuiltins = ['fs', 'fs/promises', 'path', 'readline', 'child_process', 'util'];

await build({
  entryPoints: ['src/browser.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  inject: ['./scripts/browser/buffer-shim.js'],
  alias: Object.fromEntries(nodeBuiltins.flatMap(name => [[name, stub], [`node:${name}`, stub]])),
  logLevel: 'warning',
});

const code = readFileSync(outfile);
const sizes = { bytes: code.length, gzipBytes: gzipSync(code).length };
// Read by the smoke test, which must not import fs itself
writeFileSync('dist-browser/minidb.size.json', JSON.stringify(sizes));
console.log(`${outfile}: ${(sizes.bytes / 1024).toFixed(1)} KB (${(sizes.gzipBytes / 1024).toFixed(1)} KB gzip)`);
