/** Load-time validation and row handling (ETL spec §8, §7.2.3). */
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { DatasetDef } from './datasets.js';

/** Rows the load drops (empty natural key) or dedupes (repeated key), counted for the run record. */
export interface SanitizeStats {
  /** Rows dropped because a natural-key column was empty (§7.2.3). */
  dropped: number;
  /** Rows dropped as duplicates of a kept natural key (§8). */
  deduped: number;
  /** Duplicates resolved by file order because `dedupeBy` was absent (2025+ injuries, §7.2.3). */
  dedupedNoTiebreaker: number;
}

/** Quotes a MySQL identifier. */
const bt = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/**
 * Throws if the file header is missing a mapped column, unless that column is listed in
 * `optionalColumns` (injuries' `date_modified` / `season_type`, present in only one of its two headers,
 * §7.2). A structural failure (§8): the throw marks the piece failed, leaving the previous data in place.
 */
export function assertHeader(def: DatasetDef, header: readonly string[]): void {
  if (!def.columns) return;
  const present = new Set(header);
  const optional = new Set(def.optionalColumns ?? []);
  const missing = Object.keys(def.columns).filter(
    (column) => !present.has(column) && !optional.has(column),
  );
  if (missing.length) {
    throw new Error(`${def.name}: file header is missing mapped column(s): ${missing.join(', ')}`);
  }
}

/** The natural-key string of a row, or null when any key column is empty (so the row is dropped). */
function keyOf(def: DatasetDef, row: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const col of def.naturalKey ?? []) {
    const value = row[col];
    if (value === undefined || value === '' || value === 'NA') return null;
    parts.push(value);
  }
  return parts.join('\u0000');
}

/**
 * Yields the rows to load: drops rows whose natural key has an empty column (counted in `stats.dropped`),
 * and for a dataset with `dedupeBy` keeps one row per natural key — the one with the greatest `dedupeBy`
 * value, or the last seen when that column is absent/empty (2025+ injuries, §7.2.3; owner: keep last +
 * warn, counted in `stats.dedupedNoTiebreaker`). A dataset without `dedupeBy` streams; an unexpected
 * repeated key is left to the staging primary key, which blocks the load (§8). `dedupeBy` is read from
 * the raw CSV value (ISO-8601 sorts lexically), before any cast.
 */
export async function* sanitize(
  def: DatasetDef,
  records: AsyncIterable<Record<string, string>>,
  stats: SanitizeStats,
): AsyncGenerator<Record<string, string>> {
  if (!def.dedupeBy) {
    for await (const row of records) {
      if (def.naturalKey && keyOf(def, row) === null) {
        stats.dropped++;
        continue;
      }
      yield row;
    }
    return;
  }

  const by = def.dedupeBy;
  const kept = new Map<string, Record<string, string>>();
  for await (const row of records) {
    const key = keyOf(def, row);
    if (key === null) {
      stats.dropped++;
      continue;
    }
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, row);
      continue;
    }
    stats.deduped++;
    const existingStamp = existing[by] ?? '';
    const incomingStamp = row[by] ?? '';
    if (existingStamp === '' && incomingStamp === '') stats.dedupedNoTiebreaker++;
    // greater timestamp wins; both empty -> later row wins (owner)
    if (incomingStamp >= existingStamp) kept.set(key, row);
  }
  for (const row of kept.values()) yield row;
}

/**
 * Reads the file header from the first row, asserts it matches the mapping (§8, blocks on mismatch
 * before any staging table is created), then returns the sanitized record stream and a live `stats`
 * object the caller reads after loading.
 */
export async function prepareRecords(
  def: DatasetDef,
  raw: AsyncIterable<Record<string, string>>,
): Promise<{ records: AsyncIterable<Record<string, string>>; stats: SanitizeStats }> {
  const iterator = raw[Symbol.asyncIterator]();
  const first = await iterator.next();
  assertHeader(def, first.done ? [] : Object.keys(first.value));
  const stats: SanitizeStats = { dropped: 0, deduped: 0, dedupedNoTiebreaker: 0 };

  async function* reinjected(): AsyncGenerator<Record<string, string>> {
    if (!first.done) yield first.value;
    let next = await iterator.next();
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  }

  return { records: sanitize(def, reinjected(), stats), stats };
}

/**
 * Counts fact rows whose non-null reference has no matching parent (player/game references carry no
 * database foreign key, §7.2) and returns one warning per reference with misses (§8 value check: warns,
 * never blocks). A history dataset is limited to the loaded season. A reference whose parent table is
 * empty is skipped, so a backfill that loads facts before their parents doesn't report spurious misses.
 */
export async function countMissingReferences(pool: Pool, def: DatasetDef, season: number): Promise<string[]> {
  if (!def.references?.length || !def.table) return [];
  const table = def.table;
  const seasonColumn = def.seasonColumn ?? 'season';
  const warnings: string[] = [];

  for (const ref of def.references) {
    const [exists] = await pool.query<RowDataPacket[]>(`SELECT EXISTS(SELECT 1 FROM ${bt(ref.table)}) AS e`);
    if (!Number(exists[0]?.e)) continue; // parent not loaded yet

    const where = [`f.${bt(ref.column)} IS NOT NULL`, `p.${bt(ref.parentColumn)} IS NULL`];
    const params: unknown[] = [];
    if (def.scope === 'history') {
      where.push(`f.${bt(seasonColumn)} = ?`);
      params.push(season);
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ${bt(table)} AS f
         LEFT JOIN ${bt(ref.table)} AS p ON f.${bt(ref.column)} = p.${bt(ref.parentColumn)}
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const orphanCount = Number(rows[0]?.n ?? 0);
    if (orphanCount > 0) {
      warnings.push(
        `${def.name} ${season}: ${orphanCount} row(s) with ${ref.column} not in ${ref.table}.${ref.parentColumn}`,
      );
    }
  }
  return warnings;
}
