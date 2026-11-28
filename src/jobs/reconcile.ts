/** Entry point: one reconciliation run now (ADR-0028). Usage: npm run reconcile */
import { closePool } from '../db/pool.js';
import { runReconciliation } from '../modules/pipeline/service/reconcile.service.js';

const summary = await runReconciliation();
for (const line of summary.details) console.log(line);
for (const warning of summary.warnings) console.log(`WARN ${warning}`);
console.log(`job_run ${summary.jobRunId}: ${summary.outcome} (reconciled ${summary.loaded}, skipped ${summary.skipped}, failed ${summary.failed})`);
await closePool();
process.exitCode = summary.outcome === 'failed' ? 1 : 0;
