/** Builds CSV-header -> MySQL-column maps for the dataset registry (ETL spec §6, §7.2.2; ADR-0010). */
import type { ColumnSpec } from './datasets.js';

/** A dataset's CSV-header -> MySQL-column map, as `loadPiece` consumes it. */
export type ColumnMap = Record<string, ColumnSpec>;

/**
 * Builds an identity map (each CSV header -> an identically named MySQL column) over `names`,
 * applying a cast from `casts` to any named column. nflverse headers are kept verbatim as column
 * names (ETL spec §7.2.2), so the mapping is identity except for the few columns that need a cast.
 * A CSV column absent from `names` (e.g. the fantasy-point columns, ADR-0007) is left unmapped and
 * ignored by the loader; a name absent from the CSV loads as NULL (so list only real columns).
 */
export function columnsFor(
  names: readonly string[],
  casts: Readonly<Record<string, (value: string) => unknown>> = {},
): ColumnMap {
  const out: ColumnMap = {};
  for (const name of names) out[name] = casts[name] ? { to: name, cast: casts[name] } : name;
  return out;
}
