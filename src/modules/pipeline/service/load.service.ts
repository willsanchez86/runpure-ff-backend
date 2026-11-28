/**
 * Loads one piece through a staging table, by upsert (ADR-0006, ADR-0028; ETL spec §5.3), and
 * writes provider IDs as mapping rows (ADR-0023). No statement here deletes rows of a data table:
 * removed rows are handled only by the quarterly reconciliation (reconcile.service.ts).
 */
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { env } from '../../../config/env.js';
import { upsertLedger, type LedgerPiece } from '../model/pipeline.model.js';
import type { ColumnSpec, DatasetDef, SourceIdSpec, SqlStep } from './datasets.js';
import { DownloadError } from './nflverse.service.js';

/** CSV tokens treated as NULL. nflverse files are written from R, which uses "NA". */
const NULL_TOKENS = new Set(['', 'NA']);

/** MySQL errors a retry cannot fix: a missing parent row (1452) and a duplicate key (1062). */
const PERMANENT_ERRNOS = new Set([1452, 1062]);

/** Publishing attempts per piece: the first try plus two retries (ADR-0006). */
export const PUBLISH_ATTEMPTS = 3;

/** Converts one CSV value: NULL tokens to null, then the optional cast. */
function convert(value: string | undefined, spec: ColumnSpec): unknown {
  if (value === undefined || NULL_TOKENS.has(value)) return null;
  if (typeof spec === 'string') return value;
  return spec.cast ? spec.cast(value) : value;
}

/**
 * A provider ID as stored text: surrounding space removed and a float rendering of a whole number
 * ("44822.0") reduced to its digits, so the same ID from two files compares equal (ADR-0023).
 */
export function normalizeSourceId(value: string): string {
  const trimmed = value.trim();
  return /^\d+\.0+$/.test(trimmed) ? trimmed.slice(0, trimmed.indexOf('.')) : trimmed;
}

/** Quotes a MySQL identifier. */
const id = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/** What a load reports besides its row count: lines for the run log and warnings for conflicts. */
export interface LoadReport {
  /** Rows staged from the file (the piece's row count in the ledger). */
  rows: number;
  /** Informational lines: counts written by the dataset's steps, retries. */
  notes: string[];
  /** Values not stored: conflicting or shared provider IDs (ADR-0023). */
  warnings: string[];
}

/** Runs one registry statement against the staging table and logs its affected rows when asked. */
async function runStep(conn: PoolConnection, step: SqlStep, staging: string, notes: string[]): Promise<void> {
  const [result] = await conn.query<ResultSetHeader>(step.sql.replaceAll('{staging}', id(staging)));
  if (step.report && result.affectedRows > 0) notes.push(`${step.report}: ${result.affectedRows}`);
}

/** The first row's `n` column of a COUNT query. */
async function countOf(conn: PoolConnection, sql: string): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(sql);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Writes a dataset's provider-ID columns as mapping rows (ADR-0023). The staged columns are first
 * unpivoted into a scratch table of (owner, provider, ID). An ID shared by two owners in the file,
 * or already held by another owner, is not stored and is reported. In `authoritative` mode a
 * changed ID replaces the stored one; in `fill` mode an ID is stored only where the owner has none
 * for that provider, and a differing value is reported (players.csv wins over the roster).
 */
async function writeSourceIds(conn: PoolConnection, staging: string, spec: SourceIdSpec, report: LoadReport): Promise<void> {
  const unpivoted = id(`${spec.table}__unpivoted`);
  const shared = id(`${spec.table}__shared`);
  const scratch = id(`${spec.table}__ids`);
  const target = id(spec.table);
  const owner = id(spec.ownerColumn);
  const sourceId = id(spec.idColumn);
  const scratchColumns = `(
       owner ${spec.ownerType} NOT NULL,
       source_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       PRIMARY KEY (owner, source_code),
       KEY (source_code, source_id))`;

  await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${unpivoted}, ${shared}, ${scratch}`);
  await conn.query(`CREATE TEMPORARY TABLE ${unpivoted} ${scratchColumns}`);
  // One statement per provider column: a TEMPORARY table can be read only once per statement.
  for (const [column, code] of Object.entries(spec.columns)) {
    await conn.query(
      `INSERT INTO ${unpivoted} (owner, source_code, source_id)
       SELECT ${id(spec.stagingOwner)}, ?, MAX(${id(column)}) FROM ${id(staging)}
        WHERE ${id(column)} IS NOT NULL AND ${id(spec.stagingOwner)} IS NOT NULL
        GROUP BY ${id(spec.stagingOwner)}`,
      [code],
    );
  }

  // An ID claimed by two owners in this file belongs to neither with certainty: store none of them.
  await conn.query(
    `CREATE TEMPORARY TABLE ${shared} AS
     SELECT source_code, source_id FROM ${unpivoted} GROUP BY source_code, source_id HAVING COUNT(*) > 1`,
  );
  const sharedCount = await countOf(
    conn,
    `SELECT COUNT(*) AS n FROM ${unpivoted} AS ids JOIN ${shared} AS dup
       ON dup.source_code = ids.source_code AND dup.source_id = ids.source_id`,
  );
  if (sharedCount > 0) {
    report.warnings.push(`${spec.table}: ${sharedCount} ID(s) shared by more than one row in the file, not stored`);
  }
  // An ID another owner already holds is not stored either.
  const takenCount = await countOf(
    conn,
    `SELECT COUNT(*) AS n FROM ${unpivoted} AS ids JOIN ${target} AS held
       ON held.source_code = ids.source_code AND held.${sourceId} = ids.source_id AND held.${owner} <> ids.owner`,
  );
  if (takenCount > 0) {
    report.warnings.push(`${spec.table}: ${takenCount} ID(s) already held by another row, not stored`);
  }
  // The IDs that may be stored: everything unpivoted except the shared and the already-held ones.
  await conn.query(`CREATE TEMPORARY TABLE ${scratch} ${scratchColumns}`);
  await conn.query(
    `INSERT INTO ${scratch} (owner, source_code, source_id)
     SELECT ids.owner, ids.source_code, ids.source_id
       FROM ${unpivoted} AS ids
       LEFT JOIN ${shared} AS dup ON dup.source_code = ids.source_code AND dup.source_id = ids.source_id
       LEFT JOIN ${target} AS held
         ON held.source_code = ids.source_code AND held.${sourceId} = ids.source_id AND held.${owner} <> ids.owner
      WHERE dup.source_code IS NULL AND held.${owner} IS NULL`,
  );

  const differing = `FROM ${target} AS held JOIN ${scratch} AS ids
      ON ids.owner = held.${owner} AND ids.source_code = held.source_code
   WHERE held.${sourceId} <> ids.source_id`;
  if (spec.mode === 'fill') {
    const conflicts = await countOf(conn, `SELECT COUNT(*) AS n ${differing}`);
    if (conflicts > 0) {
      report.warnings.push(`${spec.table}: ${conflicts} ID(s) differ from the stored value and were not stored`);
    }
  } else {
    if (spec.unlink) {
      // Rows pointing at an ID about to change are unlinked first; the re-link step links them again.
      // Two steps, so MySQL can't pick a slow join: read the (few) IDs about to change, then
      // unlink the child rows that point at them through the child's own index.
      const [replaced] = await conn.query<RowDataPacket[]>(
        `SELECT held.source_code AS source_code, held.${sourceId} AS old_id
           FROM ${scratch} AS ids JOIN ${target} AS held
             ON held.${owner} = ids.owner AND held.source_code = ids.source_code
          WHERE held.${sourceId} <> ids.source_id`,
      );
      for (let start = 0; start < replaced.length; start += 500) {
        const pairs = replaced.slice(start, start + 500).map((row) => [row.source_code, row.old_id]);
        await conn.query(
          `UPDATE ${id(spec.unlink.table)} SET ${id(spec.unlink.codeColumn)} = NULL
            WHERE (${id(spec.unlink.codeColumn)}, ${id(spec.unlink.idColumn)}) IN (?)`,
          [pairs],
        );
      }
    }
    const [changed] = await conn.query<ResultSetHeader>(
      `UPDATE ${target} AS held JOIN ${scratch} AS ids
          ON ids.owner = held.${owner} AND ids.source_code = held.source_code
         SET held.${sourceId} = ids.source_id
       WHERE held.${sourceId} <> ids.source_id`,
    );
    if (changed.affectedRows > 0) report.notes.push(`${spec.table}: ${changed.affectedRows} ID(s) changed`);
  }

  const [added] = await conn.query<ResultSetHeader>(
    `INSERT INTO ${target} (${owner}, source_code, ${sourceId})
     SELECT ids.owner, ids.source_code, ids.source_id
       FROM ${scratch} AS ids LEFT JOIN ${target} AS held
         ON held.${owner} = ids.owner AND held.source_code = ids.source_code
      WHERE held.${owner} IS NULL`,
  );
  if (added.affectedRows > 0) report.notes.push(`${spec.table}: ${added.affectedRows} ID(s) added`);
  await conn.query(`DROP TEMPORARY TABLE IF EXISTS ${unpivoted}, ${shared}, ${scratch}`);
}

/** The statement that upserts a piece from staging into its table: inserts new rows, updates changed ones. */
function upsertSql(def: DatasetDef, table: string, staging: string, targetColumns: readonly string[]): string {
  const keep = new Set(def.keepStored ?? []);
  const updates = targetColumns.map((column) => {
    const custom = def.updateExpressions?.[column];
    if (custom) return `${id(column)} = ${custom.replace(/\bt\./g, `${id(table)}.`)}`;
    // keepStored: an empty file value leaves the stored value in place (ADR-0026).
    if (keep.has(column)) return `${id(column)} = COALESCE(s.${id(column)}, ${id(table)}.${id(column)})`;
    return `${id(column)} = s.${id(column)}`;
  });
  const cols = targetColumns.map(id).join(', ');
  return `INSERT INTO ${id(table)} (${cols}) SELECT ${cols} FROM ${id(staging)} AS s ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;
}

/**
 * Streams records into a session-scoped TEMPORARY staging table shaped like the target, plus the
 * dataset's `stageOnly` columns, and returns the row count. A failure of the record stream itself
 * (a stalled or broken download) is rethrown as a DownloadError so the caller can retry the piece.
 */
export async function stageRecords(
  conn: PoolConnection,
  def: DatasetDef,
  staging: string,
  records: AsyncIterable<Record<string, string>>,
  onlyColumns?: readonly string[],
): Promise<number> {
  if (!def.table || !def.columns) throw new Error(`dataset ${def.name} has no table/columns mapping`);
  const columns = def.columns;
  const stageOnly = onlyColumns ? {} : def.stageOnly ?? {};
  const csvColumns = onlyColumns ?? Object.keys(columns);
  const stagedNames = [
    ...csvColumns.map((column) => {
      const spec = columns[column];
      return typeof spec === 'string' ? spec : spec.to;
    }),
    ...Object.keys(stageOnly),
  ];
  const providerIdColumns = new Set(def.sourceIds ? Object.keys(def.sourceIds.columns) : []);

  // Session-scoped staging: invisible to other connections and discarded when this one closes.
  await conn.query('DROP TEMPORARY TABLE IF EXISTS ??', [staging]);
  await conn.query('CREATE TEMPORARY TABLE ?? LIKE ??', [staging, def.table]);
  const extra = Object.entries(stageOnly).map(([column, type]) => `ADD COLUMN ${id(column)} ${type}`);
  if (extra.length) await conn.query(`ALTER TABLE ${id(staging)} ${extra.join(', ')}`);

  let batch: unknown[][] = [];
  let total = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await conn.query('INSERT INTO ?? (??) VALUES ?', [staging, stagedNames, batch]);
    total += batch.length;
    batch = [];
  };

  const iterator = records[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<Record<string, string>>;
    try {
      next = await iterator.next();
    } catch (err) {
      throw new DownloadError(err instanceof Error ? err.message : String(err));
    }
    if (next.done) break;
    const record = next.value;
    const row = csvColumns.map((column) => convert(record[column], columns[column]));
    for (const column of Object.keys(stageOnly)) {
      const value = convert(record[column], column);
      row.push(typeof value === 'string' && providerIdColumns.has(column) ? normalizeSourceId(value) : value);
    }
    batch.push(row);
    if (batch.length >= env.loadBatchSize) await flush();
  }
  await flush();
  return total;
}

/**
 * Loads one piece (dataset x season) into its table:
 *   1. rows stream into a session-scoped `<table>__staging` TEMPORARY table in batches;
 *   2. one transaction runs the dataset's `before` steps, upserts the table from staging (new rows
 *      inserted, changed rows updated, none deleted), runs its `after` steps, writes its provider
 *      IDs as mapping rows, runs `relink`, and marks the piece loaded in ingest_ledger;
 *   3. staging is dropped.
 * A crash before step 2 leaves the target untouched; the TEMPORARY staging is discarded when the
 * connection closes, and an errored load destroys its connection so nothing lingers (ADR-0006).
 * A load whose staged row count falls below `previousRows * env.rowCountMinRatio` is blocked before
 * publishing (§8), keeping the previous data.
 *
 * A publishing transaction that fails is retried up to two more times on the same staging table
 * (ADR-0006); a missing parent row or a duplicate key fails at once, since a retry would fail the
 * same way. The `loaded` ledger row is written inside the transaction, so it commits or rolls back
 * with the data.
 *
 * `previousRows` is the last successful load's row count for this piece, or null when there is none.
 */
export async function loadPiece(
  pool: Pool,
  def: DatasetDef,
  season: number,
  records: AsyncIterable<Record<string, string>>,
  previousRows: number | null = null,
  ledger: LedgerPiece | null = null,
  relink: readonly SqlStep[] = [],
): Promise<LoadReport> {
  if (!def.table || !def.columns) {
    throw new Error(`dataset ${def.name} has no table/columns mapping`);
  }
  const table = def.table;
  const staging = `${table}__staging`;
  const targetColumns = Object.values(def.columns).map((spec) => (typeof spec === 'string' ? spec : spec.to));
  const report: LoadReport = { rows: 0, notes: [], warnings: [] };

  const conn = await pool.getConnection();
  let ok = false;
  try {
    report.rows = await stageRecords(conn, def, staging, records);

    // Structural check (§8): block a load whose row count fell sharply, keeping the previous data.
    if (previousRows !== null && previousRows > 0 && report.rows < previousRows * env.rowCountMinRatio) {
      await conn.query('DROP TEMPORARY TABLE IF EXISTS ??', [staging]);
      throw new Error(
        `${def.name} ${season}: staged ${report.rows} rows, below the ` +
          `${Math.floor(previousRows * env.rowCountMinRatio)} needed (${previousRows} previously); load blocked`,
      );
    }

    for (let attempt = 1; ; attempt++) {
      const attemptReport: LoadReport = { rows: report.rows, notes: [], warnings: [] };
      await conn.beginTransaction();
      try {
        for (const step of def.before ?? []) await runStep(conn, step, staging, attemptReport.notes);
        await conn.query(upsertSql(def, table, staging, targetColumns));
        for (const step of def.after ?? []) await runStep(conn, step, staging, attemptReport.notes);
        if (def.sourceIds) await writeSourceIds(conn, staging, def.sourceIds, attemptReport);
        for (const step of relink) await runStep(conn, step, staging, attemptReport.notes);
        if (ledger) {
          await upsertLedger(conn, { ...ledger, status: 'loaded', rowsLoaded: report.rows, error: null });
        }
        await conn.commit();
        report.notes.push(...attemptReport.notes);
        report.warnings.push(...attemptReport.warnings);
        break;
      } catch (err) {
        await conn.rollback();
        const errno = (err as { errno?: number }).errno;
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= PUBLISH_ATTEMPTS || (errno !== undefined && PERMANENT_ERRNOS.has(errno))) throw err;
        // Staging was filled outside the transaction, so it survives the rollback: nothing is downloaded again.
        report.notes.push(`publish attempt ${attempt} of ${PUBLISH_ATTEMPTS} failed, retrying: ${message}`);
      }
    }

    await conn.query('DROP TEMPORARY TABLE IF EXISTS ??', [staging]);
    ok = true;
    return report;
  } finally {
    // On error, destroy rather than release: a closed connection can't carry a leftover temp table
    // back into the pool to collide with the next load.
    if (ok) conn.release();
    else conn.destroy();
  }
}
