/** One pipeline run: ledger, piece-by-piece upsert load, retries, re-linking (ADR-0006, ADR-0024, ADR-0028). */
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../../../db/pool.js';
import { env } from '../../../config/env.js';
import {
  findLedger,
  finishJobRun,
  startJobRun,
  upsertLedger,
  type JobKind,
  type JobOutcome,
} from '../model/pipeline.model.js';
import { RELINK_STEPS, UNLINKED_COUNTS, datasets } from './datasets.js';
import { loadPiece } from './load.service.js';
import { DownloadError, headSource, openCsv, sourceUrl } from './nflverse.service.js';
import { seasonsToLoad, type SeasonRange } from './season.js';
import { loadParentKeys, prepareRecords } from './validate.service.js';

/** job_run.error is TEXT (64 KB): the stored run log is cut to this many characters. */
const MAX_STORED_LOG = 60000;

/** What one run loads. */
export interface RunOptions {
  kind: JobKind;
  /** Limit to these dataset names. Default: all. */
  datasets?: string[];
  /** Backfill season range. Default: each dataset's first season to its current season. */
  range?: SeasonRange;
  /** Reload even when the source ETag is unchanged. */
  force?: boolean;
}

/** What one run did, for logs, the CLI and the stored run record. */
export interface RunSummary {
  jobRunId: number | null;
  outcome: JobOutcome;
  loaded: number;
  skipped: number;
  failed: number;
  /** One line per piece and per count (rows loaded, dropped, excluded, linked, retries). */
  details: string[];
  /** Findings that need attention but block nothing: conflicting or shared IDs, unlinked rows (§8). */
  warnings: string[];
}

/**
 * The text stored in job_run.error: warnings first under `WARNINGS:`, then every detail line under
 * `LOG:`, so each run's counts and retries can be looked up later (ADR-0006). Null when both are empty.
 */
export function storedRunLog(summary: Pick<RunSummary, 'details' | 'warnings'>): string | null {
  const sections: string[] = [];
  if (summary.warnings.length) sections.push(`WARNINGS:\n${summary.warnings.join('\n')}`);
  if (summary.details.length) sections.push(`LOG:\n${summary.details.join('\n')}`);
  if (sections.length === 0) return null;
  const text = sections.join('\n');
  return text.length > MAX_STORED_LOG ? `${text.slice(0, MAX_STORED_LOG)}\n[log cut at ${MAX_STORED_LOG} characters]` : text;
}

/**
 * Links rows loaded earlier without a player once the matching provider ID is known, then records
 * how many rows remain unlinked (ADR-0024).
 */
export async function relinkAndCount(pool: Pool, summary: Pick<RunSummary, 'details' | 'warnings'>): Promise<void> {
  for (const step of RELINK_STEPS) {
    const [result] = await pool.query<ResultSetHeader>(step.sql);
    if (step.report && result.affectedRows > 0) summary.details.push(`${step.report}: ${result.affectedRows}`);
  }
  for (const count of UNLINKED_COUNTS) {
    const [rows] = await pool.query<RowDataPacket[]>(count.sql);
    const unlinked = Number(rows[0]?.n ?? 0);
    if (unlinked > 0) summary.warnings.push(`${count.label}: ${unlinked}`);
  }
}

/**
 * One pipeline run: record a job_run, then for every selected dataset x season: check the source
 * version, skip if unchanged, otherwise stream it into MySQL by upsert, marking the ledger row
 * loaded in the same transaction. A download that breaks mid-stream re-runs the piece, up to
 * FETCH_ATTEMPTS tries. A failed piece is recorded and the run goes on; the next run retries it.
 * Runs are not coordinated: loads are idempotent, and overlapping runs are an accepted risk (ADR-0006).
 */
export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  const pool = getPool();
  const summary: RunSummary = { jobRunId: null, outcome: 'running', loaded: 0, skipped: 0, failed: 0, details: [], warnings: [] };

  summary.jobRunId = await startJobRun(pool, opts.kind);
  const selected = datasets.filter((dataset) => !opts.datasets || opts.datasets.includes(dataset.name));

  for (const def of selected) {
    if (!def.table || !def.columns) {
      summary.skipped++;
      summary.details.push(`${def.name}: no table/columns mapping yet, skipped`);
      continue;
    }

    for (const season of seasonsToLoad(def, opts.kind, opts.range)) {
      const label = `${def.name} ${season === 0 ? 'all' : season}`;
      const url = sourceUrl(def, season);
      const noteRetry = (message: string): void => {
        summary.details.push(`${label}: download ${message}`);
      };
      try {
        const version = await headSource(url, noteRetry);
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
        const previousRows = previous?.status === 'loaded' ? previous.rows_loaded : null;
        await upsertLedger(pool, { ...base, status: 'downloading' });

        // A download that breaks while rows are streaming is started over, within FETCH_ATTEMPTS tries.
        for (let attempt = 1; ; attempt++) {
          try {
            const raw = await openCsv(url, def.gzip, noteRetry);
            // Validate the header (blocks on mismatch), then drop, dedupe and exclude rows (§8, §7.2.3, ADR-0024).
            const { records, stats } = await prepareRecords(def, raw, await loadParentKeys(pool, def));
            // loadPiece marks the ledger row loaded inside the publishing transaction.
            const report = await loadPiece(pool, def, season, records, previousRows, base, RELINK_STEPS);

            summary.loaded++;
            let detail = `${label}: loaded ${report.rows} rows`;
            if (stats.dropped) detail += `, dropped ${stats.dropped} (empty key)`;
            if (stats.deduped) detail += `, deduped ${stats.deduped}`;
            if (stats.excluded) detail += `, excluded ${stats.excluded} (${def.requireParent?.column} not in ${def.requireParent?.table})`;
            summary.details.push(detail);
            summary.details.push(...report.notes.map((note) => `${label}: ${note}`));
            summary.warnings.push(...report.warnings.map((warning) => `${label}: ${warning}`));
            if (stats.dedupedNoTiebreaker) {
              summary.warnings.push(
                `${label}: ${stats.dedupedNoTiebreaker} duplicate key(s) kept by file order (no date_modified)`,
              );
            }
            break;
          } catch (err) {
            if (!(err instanceof DownloadError) || attempt >= env.fetchAttempts) throw err;
            noteRetry(`attempt ${attempt} of ${env.fetchAttempts} broke mid-stream, starting the piece over: ${err.message}`);
          }
        }
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
        }).catch((ledgerError) =>
          console.error('could not record failure in ledger', ledgerError),
        );
      }
    }
  }

  // Rows loaded before their player's provider ID was known are linked now (ADR-0024).
  await relinkAndCount(pool, summary).catch((err) => {
    summary.warnings.push(`re-link step failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  summary.outcome = summary.failed > 0 ? 'failed' : 'ok';
  await finishJobRun(pool, summary.jobRunId, summary.outcome, summary, storedRunLog(summary));
  return summary;
}
