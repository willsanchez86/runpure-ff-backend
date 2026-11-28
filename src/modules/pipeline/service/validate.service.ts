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
  /** Rows left out because their reference is missing from the parent table (roster rows, ADR-0024). */
  excluded: number;
}

/** Quotes a MySQL identifier. */
const bt = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

/**
 * The parent-table keys a dataset's rows must reference to be loaded (ADR-0024), or undefined when
 * the dataset has no such requirement. Read once per piece, before its file is streamed.
 */
export async function loadParentKeys(pool: Pool, def: DatasetDef): Promise<Set<string> | undefined> {
  if (!def.requireParent) return undefined;
  const { table, parentColumn } = def.requireParent;
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${bt(parentColumn)} AS parent_key FROM ${bt(table)}`);
  return new Set(rows.map((row) => String(row.parent_key)));
}

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
  parentKeys?: ReadonlySet<string>,
): AsyncGenerator<Record<string, string>> {
  if (!def.dedupeBy) {
    for await (const row of records) {
      if (def.naturalKey && keyOf(def, row) === null) {
        stats.dropped++;
        continue;
      }
      // A row naming a parent that doesn't exist is left out and counted (roster rows, ADR-0024).
      if (parentKeys && def.requireParent && !parentKeys.has(row[def.requireParent.column])) {
        stats.excluded++;
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
 * object the caller reads after loading. With `parentKeys` (from `loadParentKeys`), rows whose
 * required parent is missing are excluded and counted.
 */
export async function prepareRecords(
  def: DatasetDef,
  raw: AsyncIterable<Record<string, string>>,
  parentKeys?: ReadonlySet<string>,
): Promise<{ records: AsyncIterable<Record<string, string>>; stats: SanitizeStats }> {
  const iterator = raw[Symbol.asyncIterator]();
  const first = await iterator.next();
  assertHeader(def, first.done ? [] : Object.keys(first.value));
  const stats: SanitizeStats = { dropped: 0, deduped: 0, dedupedNoTiebreaker: 0, excluded: 0 };

  async function* reinjected(): AsyncGenerator<Record<string, string>> {
    if (!first.done) yield first.value;
    let next = await iterator.next();
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  }

  return { records: sanitize(def, reinjected(), stats, parentKeys), stats };
}
