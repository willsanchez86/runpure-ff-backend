/** Queries on ingest_ledger and job_run (ADR-0006; ETL spec §5.3; sql/0001_pipeline_tables.sql). */
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

// Timestamps are written with UTC_TIMESTAMP(): DATETIME values are UTC (ETL spec §7.2.2).

// ---- ingest_ledger ---------------------------------------------------------

/** Ledger state of one piece. */
export type LedgerStatus = 'downloading' | 'loaded' | 'failed';

/** One ingest_ledger row: a dataset for one season (season 0 for single files). */
export interface LedgerRow extends RowDataPacket {
  id: number;
  dataset: string;
  season: number;
  source_url: string;
  source_etag: string | null;
  source_last_modified: string | null;
  content_length: number | null;
  status: LedgerStatus;
  rows_loaded: number | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** The ledger row for one piece, if any. */
export async function findLedger(pool: Pool, dataset: string, season: number): Promise<LedgerRow | undefined> {
  const [rows] = await pool.query<LedgerRow[]>(
    'SELECT * FROM ingest_ledger WHERE dataset = ? AND season = ?',
    [dataset, season],
  );
  return rows[0];
}

/** Every ledger row, by dataset and season. */
export async function listLedger(pool: Pool): Promise<LedgerRow[]> {
  const [rows] = await pool.query<LedgerRow[]>('SELECT * FROM ingest_ledger ORDER BY dataset, season');
  return rows;
}

/** Values written to the ledger for one piece. */
export interface LedgerUpsert {
  dataset: string;
  season: number;
  sourceUrl: string;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
  status: LedgerStatus;
  rowsLoaded?: number | null;
  error?: string | null;
}

/** Inserts or updates a piece's ledger row. Status downloading restarts started_at and clears finished_at. */
export async function upsertLedger(pool: Pool, u: LedgerUpsert): Promise<void> {
  await pool.query(
    `INSERT INTO ingest_ledger
       (dataset, season, source_url, source_etag, source_last_modified, content_length,
        status, rows_loaded, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), IF(? = 'downloading', NULL, UTC_TIMESTAMP())) AS new
     ON DUPLICATE KEY UPDATE
       source_url = new.source_url,
       source_etag = new.source_etag,
       source_last_modified = new.source_last_modified,
       content_length = new.content_length,
       status = new.status,
       rows_loaded = new.rows_loaded,
       error = new.error,
       started_at = IF(new.status = 'downloading', UTC_TIMESTAMP(), ingest_ledger.started_at),
       finished_at = IF(new.status = 'downloading', NULL, UTC_TIMESTAMP())`,
    [
      u.dataset,
      u.season,
      u.sourceUrl,
      u.etag,
      u.lastModified,
      u.contentLength,
      u.status,
      u.rowsLoaded ?? null,
      u.error ?? null,
      u.status,
    ],
  );
}

// ---- job_run ---------------------------------------------------------------

/** Kind of pipeline run. */
export type JobKind = 'ingest' | 'backfill';
/** Result of a pipeline run. */
export type JobOutcome = 'running' | 'ok' | 'failed' | 'skipped_locked';

/** One job_run row. */
export interface JobRunRow extends RowDataPacket {
  id: number;
  kind: JobKind;
  started_at: Date;
  finished_at: Date | null;
  outcome: JobOutcome;
  pieces_loaded: number;
  pieces_skipped: number;
  pieces_failed: number;
  error: string | null;
}

/** Pieces loaded, skipped and failed in one run. */
export interface PieceCounts {
  loaded: number;
  skipped: number;
  failed: number;
}

/** Records a new run as running; returns its id. */
export async function startJobRun(pool: Pool, kind: JobKind): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO job_run (kind, started_at) VALUES (?, UTC_TIMESTAMP())',
    [kind],
  );
  return result.insertId;
}

/** Records a run's outcome, counts and any error. */
export async function finishJobRun(
  pool: Pool,
  id: number,
  outcome: JobOutcome,
  counts: PieceCounts,
  error: string | null = null,
): Promise<void> {
  await pool.query(
    `UPDATE job_run
       SET finished_at = UTC_TIMESTAMP(), outcome = ?, pieces_loaded = ?, pieces_skipped = ?, pieces_failed = ?, error = ?
     WHERE id = ?`,
    [outcome, counts.loaded, counts.skipped, counts.failed, error, id],
  );
}

/** The most recent runs, newest first. */
export async function recentJobRuns(pool: Pool, limit = 20): Promise<JobRunRow[]> {
  const [rows] = await pool.query<JobRunRow[]>(
    'SELECT * FROM job_run ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows;
}
