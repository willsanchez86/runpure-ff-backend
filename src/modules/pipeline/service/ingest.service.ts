import { getPool } from '../../../db/pool.js';
import { releaseLock, tryAcquireLock } from '../../../db/lock.js';
import {
  findLedger,
  finishJobRun,
  startJobRun,
  upsertLedger,
  type JobKind,
  type JobOutcome,
} from '../model/pipeline.model.js';
import { datasets } from './datasets.js';
import { loadPiece } from './load.service.js';
import { headSource, openCsv, sourceUrl } from './nflverse.service.js';
import { seasonsToLoad, type SeasonRange } from './season.js';

export interface RunOptions {
  kind: JobKind;
  /** Limit to these dataset names. Default: all. */
  datasets?: string[];
  /** Backfill season range. Default: HISTORY_START_SEASON..each dataset's current season. */
  range?: SeasonRange;
  /** Reload even when the source ETag is unchanged. */
  force?: boolean;
}

export interface RunSummary {
  jobRunId: number | null;
  outcome: JobOutcome;
  loaded: number;
  skipped: number;
  failed: number;
  details: string[];
}

/**
 * One pipeline run: take the run lock, record a job_run, then for every selected
 * dataset x season: check the source version, skip if unchanged, otherwise stream it
 * into MySQL and record the ledger row. A failed piece is recorded and the run goes on;
 * the next run retries it (ADR-0006).
 */
export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  const pool = getPool();
  const summary: RunSummary = { jobRunId: null, outcome: 'running', loaded: 0, skipped: 0, failed: 0, details: [] };

  const lockConn = await pool.getConnection();
  try {
    if (!(await tryAcquireLock(lockConn))) {
      const id = await startJobRun(pool, opts.kind);
      await finishJobRun(pool, id, 'skipped_locked', summary);
      summary.jobRunId = id;
      summary.outcome = 'skipped_locked';
      summary.details.push('another run holds the pipeline lock; exiting');
      return summary;
    }

    summary.jobRunId = await startJobRun(pool, opts.kind);
    const selected = datasets.filter((d) => !opts.datasets || opts.datasets.includes(d.name));

    for (const def of selected) {
      if (!def.table || !def.columns) {
        summary.skipped++;
        summary.details.push(`${def.name}: no table/columns mapping yet, skipped`);
        continue;
      }

      for (const season of seasonsToLoad(def, opts.kind, opts.range)) {
        const label = `${def.name} ${season === 0 ? 'all' : season}`;
        const url = sourceUrl(def, season);
        try {
          const version = await headSource(url);
          const previous = await findLedger(pool, def.name, season);
          const unchanged =
            !opts.force &&
            previous?.status === 'loaded' &&
            previous.source_etag !== null &&
            previous.source_etag === version.etag;
          if (unchanged) {
            summary.skipped++;
            summary.details.push(`${label}: unchanged (etag ${version.etag}), skipped`);
            continue;
          }

          const base = {
            dataset: def.name,
            season,
            sourceUrl: url,
            etag: version.etag,
            lastModified: version.lastModified,
            contentLength: version.contentLength,
          };
          await upsertLedger(pool, { ...base, status: 'downloading' });
          const records = await openCsv(url, def.gzip);
          const rows = await loadPiece(pool, def, season, records);
          await upsertLedger(pool, { ...base, status: 'loaded', rowsLoaded: rows, error: null });

          summary.loaded++;
          summary.details.push(`${label}: loaded ${rows} rows`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.failed++;
          summary.details.push(`${label}: FAILED ${message}`);
          await upsertLedger(pool, {
            dataset: def.name,
            season,
            sourceUrl: url,
            etag: null,
            lastModified: null,
            contentLength: null,
            status: 'failed',
            error: message,
          }).catch((e) => console.error('could not record failure in ledger', e));
        }
      }
    }

    summary.outcome = summary.failed > 0 ? 'failed' : 'ok';
    await finishJobRun(pool, summary.jobRunId, summary.outcome, summary);
    return summary;
  } finally {
    await releaseLock(lockConn).catch(() => undefined);
    lockConn.release();
  }
}
