import type { Pool } from 'mysql2/promise';
import { env } from '../../../config/env.js';
import type { ColumnSpec, DatasetDef } from './datasets.js';

/** CSV tokens treated as NULL. nflverse files are written from R, which uses "NA". */
const NULL_TOKENS = new Set(['', 'NA']);

function convert(value: string | undefined, spec: ColumnSpec): unknown {
  if (value === undefined || NULL_TOKENS.has(value)) return null;
  if (typeof spec === 'string') return value;
  return spec.cast ? spec.cast(value) : value;
}

/** Quotes a MySQL identifier. */
const id = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/**
 * Loads one piece (dataset x season) into its table:
 *   1. rows stream into `<table>__staging` in batches;
 *   2. one transaction deletes the rows being replaced and copies staging in, or, for
 *      an upsert dataset (the team table), inserts new rows and updates existing ones;
 *   3. staging is dropped.
 * A crash before step 2 leaves the target untouched; the next run drops the leftover
 * staging table and starts again (ADR-0006).
 */
export async function loadPiece(
  pool: Pool,
  def: DatasetDef,
  season: number,
  records: AsyncIterable<Record<string, string>>,
): Promise<number> {
  if (!def.table || !def.columns) {
    throw new Error(`dataset ${def.name} has no table/columns mapping`);
  }
  const table = def.table;
  const columns = def.columns;
  const staging = `${table}__staging`;
  const csvColumns = Object.keys(columns);
  const targetColumns = csvColumns.map((c) => {
    const spec = columns[c];
    return typeof spec === 'string' ? spec : spec.to;
  });
  const seasonColumn = def.seasonColumn ?? 'season';

  const conn = await pool.getConnection();
  try {
    await conn.query('DROP TABLE IF EXISTS ??', [staging]);
    await conn.query('CREATE TABLE ?? LIKE ??', [staging, table]);

    let batch: unknown[][] = [];
    let total = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await conn.query('INSERT INTO ?? (??) VALUES ?', [staging, targetColumns, batch]);
      total += batch.length;
      batch = [];
    };

    for await (const record of records) {
      batch.push(csvColumns.map((c) => convert(record[c], columns[c])));
      if (batch.length >= env.loadBatchSize) await flush();
    }
    await flush();

    await conn.beginTransaction();
    try {
      if (def.replace === 'upsert') {
        // Nothing is deleted: other tables' foreign keys still reference these rows.
        const updates = targetColumns.map((c) => `${id(c)} = s.${id(c)}`).join(', ');
        const cols = targetColumns.map(id).join(', ');
        await conn.query(
          `INSERT INTO ${id(table)} (${cols}) SELECT ${cols} FROM ${id(staging)} AS s ON DUPLICATE KEY UPDATE ${updates}`,
        );
        await conn.commit();
        await conn.query('DROP TABLE IF EXISTS ??', [staging]);
        return total;
      }
      if (def.scope === 'history') {
        await conn.query('DELETE FROM ?? WHERE ?? = ?', [table, seasonColumn, season]);
      } else {
        // single_file: whole table replaced; current_season: previous season removed (ADR-0013)
        await conn.query('DELETE FROM ??', [table]);
      }
      await conn.query('INSERT INTO ?? (??) SELECT ?? FROM ??', [table, targetColumns, targetColumns, staging]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }

    await conn.query('DROP TABLE IF EXISTS ??', [staging]);
    return total;
  } finally {
    conn.release();
  }
}
