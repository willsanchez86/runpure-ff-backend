/** In-process schedules for the daily ingest run and the quarterly reconciliation (ADR-0008, ADR-0028; ETL spec D7, D12). */
import { schedule, validate, type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { runPipeline } from '../modules/pipeline/service/ingest.service.js';
import { runReconciliation } from '../modules/pipeline/service/reconcile.service.js';

/**
 * In-process scheduler (ADR-0008; node-cron, ETL spec D12). It only holds schedules and
 * calls the job entry points, so moving jobs to a separate worker later means starting
 * the same entry points elsewhere. Runs are not coordinated: loads are idempotent upserts and
 * the ledger commits with the data, and overlapping runs are an accepted risk (ADR-0006).
 * Defaults: one ingest a day at 06:00 Eastern (D7); the reconciliation at 07:30 Eastern on
 * January 1, April 1, July 1 and October 1 (ADR-0028).
 */
let stopping = false;
const tasks: ScheduledTask[] = [];

/** One scheduled job: its name for the log, its cron expression and what it runs. */
interface ScheduledJob {
  name: string;
  expression: string;
  run: () => Promise<{ jobRunId: number | null; outcome: string; loaded: number; skipped: number; failed: number }>;
}

/** The jobs the scheduler starts: one ingest per PIPELINE_CRON expression, plus the reconciliation. */
export function scheduledJobs(): ScheduledJob[] {
  return [
    ...env.cronSchedules.map((expression) => ({ name: 'ingest', expression, run: () => runPipeline({ kind: 'ingest' }) })),
    { name: 'reconcile', expression: env.reconcileCron, run: runReconciliation },
  ];
}

/** Starts one cron task per scheduled job; throws on an invalid expression. */
export function startScheduler(): void {
  for (const job of scheduledJobs()) {
    if (!validate(job.expression)) throw new Error(`invalid cron expression for ${job.name}: "${job.expression}"`);
    const task = schedule(
      job.expression,
      async () => {
        if (stopping) return;
        try {
          const summary = await job.run();
          console.log(`scheduled ${job.name}: job_run ${summary.jobRunId} ${summary.outcome} (done ${summary.loaded}, skipped ${summary.skipped}, failed ${summary.failed})`);
        } catch (err) {
          console.error(`scheduled ${job.name} crashed`, err);
        }
      },
      { timezone: env.timezone },
    );
    tasks.push(task);
    console.log(`scheduled ${job.name}: "${job.expression}" (${env.timezone})`);
  }
}

/** Stops every task. A run already in progress finishes; no new run starts. */
export function stopScheduler(): void {
  stopping = true;
  for (const task of tasks) task.stop();
}
