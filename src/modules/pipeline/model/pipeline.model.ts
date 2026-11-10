import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

// Timestamps are written with UTC_TIMESTAMP(): DATETIME values are UTC (ETL spec Â§7.2.2).

// ---- ingest_ledger ---------------------------------------------------------

export type LedgerStatus = 'downloading' | 'loaded' | 'failed';

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

export async function findLedger(pool: Pool, dataset: string, season: number): Promise<LedgerRow | undefined> {
  const [rows] = await pool.query<LedgerRow[]>(
    'SELECT * FROM ingest_ledger WHERE dataset = ? AND season = ?',
    [dataset, season],
  );
  return rows[0];
}

export async function listLedger(pool: Pool): Promise<LedgerRow[]> {
  const [rows] = await pool.query<LedgerRow[]>('SELECT * FROM ingest_ledger ORDER BY dataset, season');
  return rows;
}

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

export type JobKind = 'ingest' | 'backfill';
export type JobOutcome = 'running' | 'ok' | 'failed' | 'skipped_locked';

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

export interface PieceCounts {
  loaded: number;
  skipped: number;
  failed: number;
}

export async function startJobRun(pool: Pool, kind: JobKind): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO job_run (kind, started_at) VALUES (?, UTC_TIMESTAMP())',
    [kind],
  );
  return result.insertId;
}

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

export async function recentJobRuns(pool: Pool, limit = 20): Promise<JobRunRow[]> {
  const [rows] = await pool.query<JobRunRow[]>(
    'SELECT * FROM job_run ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows;
}
