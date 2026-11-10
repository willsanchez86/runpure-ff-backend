/**
 * Entry point: the one-time history load (ADR-0006). Runs from the command line, never
 * from the scheduler. Resumable: pieces already loaded with an unchanged ETag are skipped.
 * Usage: npm run backfill -- [--from 2022] [--to 2026] [--dataset name]... [--force]
 * Without --to, each dataset loads up to its own current season (D6).
 */
import { parseArgs } from 'node:util';
import { closePool } from '../db/pool.js';
import { runPipeline } from '../modules/pipeline/service/ingest.service.js';
import { env } from '../config/env.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    dataset: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
  },
});

const from = values.from ? Number(values.from) : env.historyStartSeason;
const to = values.to ? Number(values.to) : undefined;
if (!Number.isInteger(from) || (to !== undefined && (!Number.isInteger(to) || from > to))) {
  throw new Error(`invalid season range ${from}..${to ?? 'current'}`);
}

console.log(`backfill ${from}..${to ?? 'current season'}`);
const summary = await runPipeline({ kind: 'backfill', datasets: values.dataset, range: { from, to }, force: values.force ?? false });
for (const line of summary.details) console.log(line);
console.log(`job_run ${summary.jobRunId}: ${summary.outcome} (loaded ${summary.loaded}, skipped ${summary.skipped}, failed ${summary.failed})`);
await closePool();
process.exitCode = summary.outcome === 'failed' ? 1 : 0;
