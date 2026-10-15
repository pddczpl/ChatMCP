// Local diagnostic CLI: node tests/benchmarks/summarize-parity.mjs ./results.json
// Input contains externally graded test outcomes; no model/network calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {summarizeParityBenchmark} from '../../lib/parity-benchmark.mjs';
const filename=process.argv[2];
if(!filename||process.argv.length!==3) {
  console.error('Usage: node tests/benchmarks/summarize-parity.mjs results.json');
  process.exitCode=2;
}else {
  const stat=await fs.stat(filename);
  if(!stat.isFile()||stat.size>2*1024*1024)throw Error('Benchmark JSON must be a regular file under 2 MB.');
  const contents=JSON.parse(await fs.readFile(path.resolve(filename),'utf8'));
  console.log(JSON.stringify(summarizeParityBenchmark(contents),null,2));
}
