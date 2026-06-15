import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BENCHMARKS = [
  'buffer_pool_warmup.ts',
  'btree_vs_seqscan.ts',
  'volcano_vs_vectorized.ts',
  'lru_vs_lruk.ts',
  'optimizer_explain.ts',
  'strict_2pl_concurrency.ts',
  'crash_recovery.ts'
];

async function runBenchmark(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n=============================================================`);
    console.log(` Running Benchmark: ${file}`);
    console.log(`=============================================================\n`);
    
    // Use tsx to run the benchmark script
    const child = spawn('npx', ['tsx', path.join(__dirname, file)], {
      stdio: 'inherit',
      shell: true
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Benchmark ${file} failed with exit code ${code}`));
      }
    });
  });
}

async function runAll() {
  const args = process.argv.slice(2);
  let targets = BENCHMARKS;
  
  if (args.length > 0) {
    targets = BENCHMARKS.filter(b => args.some(a => b.includes(a)));
  }

  if (targets.length === 0) {
    console.error('No matching benchmarks found for:', args);
    process.exit(1);
  }

  console.log(`Starting MiniDB Benchmark Suite...`);
  console.log(`Targeting ${targets.length} benchmarks.`);

  let successCount = 0;
  for (const file of targets) {
    try {
      await runBenchmark(file);
      successCount++;
    } catch (err: any) {
      console.error(`\n[!] Error running ${file}: ${err.message}`);
    }
  }

  console.log(`\n=============================================================`);
  console.log(` Benchmark Suite Complete. (${successCount}/${targets.length} succeeded)`);
  console.log(`=============================================================`);
  
  if (successCount < targets.length) {
    process.exit(1);
  }
}

runAll().catch(console.error);
