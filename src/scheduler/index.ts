import { schedule, validate, type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { runPipeline } from '../modules/pipeline/service/ingest.service.js';

/**
 * In-process scheduler (ADR-0008; node-cron, ETL spec D12). It only holds schedules and
 * calls the ingest entry point, so moving jobs to a separate worker later means starting
 * the same entry point elsewhere. Overlap between runs is prevented by the MySQL run
 * lock, not here. Default: one run a day at 06:00 Eastern (D7).
 */
let stopping = false;
const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
  for (const expression of env.cronSchedules) {
    if (!validate(expression)) throw new Error(`invalid cron expression in PIPELINE_CRON: "${expression}"`);
    const task = schedule(
      expression,
      async () => {
        if (stopping) return;
        try {
          const summary = await runPipeline({ kind: 'ingest' });
          console.log(`scheduled ingest: job_run ${summary.jobRunId} ${summary.outcome} (loaded ${summary.loaded}, skipped ${summary.skipped}, failed ${summary.failed})`);
        } catch (err) {
          console.error('scheduled ingest crashed', err);
        }
      },
      { timezone: env.timezone },
    );
    tasks.push(task);
    console.log(`scheduled ingest: "${expression}" (${env.timezone})`);
  }
}

export function stopScheduler(): void {
  stopping = true;
  for (const task of tasks) task.stop();
}
