/**
 * Quarterly reconciliation (ADR-0028): the only place rows of a data table are deleted. For each
 * loaded piece it reads nflverse's current file and deletes the piece's rows whose key is no
 * longer in the file. `team`, `player` and `game` are never reconciled: a row missing from a later
 * file is kept (ADR-0006), and other tables reference them.
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../../../db/pool.js';
import { env } from '../../../config/env.js';
import { finishJobRun, listLedger, startJobRun } from '../model/pipeline.model.js';
import { datasets, type DatasetDef } from './datasets.js';
import { storedRunLog, type RunSummary } from './ingest.service.js';
import { stageRecords } from './load.service.js';
import { openCsv, sourceUrl } from './nflverse.service.js';
import { prepareRecords } from './validate.service.js';

/** Quotes a MySQL identifier. */
const id = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/**
 * Deletes the rows of one piece whose natural key is absent from `keys`, a staging table holding the
 * keys of nflverse's current file, and returns how many were deleted. The piece's rows are found by
 * the dataset's `reconcile` scope: a season column, the season of the row's game, or the file's own
 * value range (depth-chart snapshots).
 */
export async function deleteRowsMissingFromFile(
  conn: PoolConnection,
  def: DatasetDef,
  season: number,
  keys: string,
): Promise<number> {
  if (!def.table || !def.reconcile || !def.naturalKey?.length) return 0;
  const table = id(def.table);
  const matchKeys = def.naturalKey.map((column) => `k.${id(column)} = t.${id(column)}`).join(' AND ');
  const missing = `k.${id(def.naturalKey[0])} IS NULL`;
  const scope = def.reconcile;

  if (scope.kind === 'column') {
    const [result] = await conn.query<ResultSetHeader>(
      `DELETE t FROM ${table} AS t LEFT JOIN ${id(keys)} AS k ON ${matchKeys}
        WHERE ${missing} AND t.${id(scope.column)} = ?`,
      [season],
    );
    return result.affectedRows;
  }
  if (scope.kind === 'game') {
    const [result] = await conn.query<ResultSetHeader>(
      `DELETE t FROM ${table} AS t JOIN game AS g ON g.game_id = t.game_id
         LEFT JOIN ${id(keys)} AS k ON ${matchKeys}
        WHERE ${missing} AND g.season = ?`,
      [season],
    );
    return result.affectedRows;
  }
  // range: only rows inside the span the file covers can be judged missing from it.
  const [span] = await conn.query<RowDataPacket[]>(
    `SELECT MIN(${id(scope.column)}) AS low, MAX(${id(scope.column)}) AS high FROM ${id(keys)}`,
  );
  if (span[0]?.low == null) return 0;
  const [result] = await conn.query<ResultSetHeader>(
    `DELETE t FROM ${table} AS t LEFT JOIN ${id(keys)} AS k ON ${matchKeys}
      WHERE ${missing} AND t.${id(scope.column)} BETWEEN ? AND ?`,
    [span[0].low, span[0].high],
  );
  return result.affectedRows;
}

/**
 * One reconciliation run, recorded in job_run with kind `reconcile`. Every loaded piece of every
 * dataset that declares a `reconcile` scope is compared with nflverse's current file. A file with
 * fewer rows than ROW_COUNT_MIN_RATIO of the last load is treated as broken and its piece is left
 * alone, so a truncated download can never empty a table.
 */
export async function runReconciliation(): Promise<RunSummary> {
  const pool = getPool();
  const summary: RunSummary = { jobRunId: null, outcome: 'running', loaded: 0, skipped: 0, failed: 0, details: [], warnings: [] };
  summary.jobRunId = await startJobRun(pool, 'reconcile');
  const ledger = await listLedger(pool);

  for (const def of datasets) {
    if (!def.table || !def.columns || !def.reconcile || !def.naturalKey) continue;
    const pieces = ledger.filter((row) => row.dataset === def.name && row.status === 'loaded');

    for (const piece of pieces) {
      const label = `${def.name} ${piece.season}`;
      const keys = `${def.table}__keys`;
      const conn = await pool.getConnection();
      let ok = false;
      try {
        const raw = await openCsv(sourceUrl(def, piece.season), def.gzip);
        const { records } = await prepareRecords(def, raw);
        const fileRows = await stageRecords(conn, def, keys, records, def.naturalKey);
        if (piece.rows_loaded !== null && fileRows < piece.rows_loaded * env.rowCountMinRatio) {
          summary.skipped++;
          summary.warnings.push(`${label}: file has ${fileRows} rows against ${piece.rows_loaded} loaded; not reconciled`);
        } else {
          await conn.beginTransaction();
          try {
            const deleted = await deleteRowsMissingFromFile(conn, def, piece.season, keys);
            await conn.commit();
            summary.loaded++;
            summary.details.push(`${label}: ${deleted} row(s) deleted (no longer in the source file)`);
          } catch (err) {
            await conn.rollback();
            throw err;
          }
        }
        await conn.query('DROP TEMPORARY TABLE IF EXISTS ??', [keys]);
        ok = true;
      } catch (err) {
        summary.failed++;
        summary.details.push(`${label}: FAILED ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (ok) conn.release();
        else conn.destroy();
      }
    }
  }

  summary.outcome = summary.failed > 0 ? 'failed' : 'ok';
  await finishJobRun(pool, summary.jobRunId, summary.outcome, summary, storedRunLog(summary));
  return summary;
}
