/** Entry point: one incremental run now. Usage: npm run ingest -- [--dataset name]... [--force] */
import { parseArgs } from 'node:util';
import { closePool } from '../db/pool.js';
import { runPipeline } from '../modules/pipeline/service/ingest.service.js';

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
  },
});

const summary = await runPipeline({ kind: 'ingest', datasets: values.dataset, force: values.force ?? false });
for (const line of summary.details) console.log(line);
console.log(`job_run ${summary.jobRunId}: ${summary.outcome} (loaded ${summary.loaded}, skipped ${summary.skipped}, failed ${summary.failed})`);
await closePool();
process.exitCode = summary.outcome === 'failed' ? 1 : 0;
