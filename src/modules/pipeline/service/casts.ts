/** Value casts for the dataset column mappings (ETL spec §6, §7.2.2; ADR-0012). */

/**
 * Normalizes an ISO-8601 UTC timestamp (e.g. `2026-11-12T15:57:12Z`, or `...:01.813Z` with
 * milliseconds) to the `YYYY-MM-DD HH:MM:SS[.fff]` form a MySQL `DATETIME`/`DATETIME(3)` column
 * accepts. nflverse writes these in UTC and the columns are UTC (ETL spec §7.2.2); the pool runs in
 * `timezone: 'Z'`, so the returned string is stored verbatim as UTC. A value that isn't a
 * recognizable ISO timestamp is returned unchanged so the DB rejects it (fail fast) rather than it
 * being silently altered. Empty/`NA` never reach a cast — `load.service.ts` maps those to NULL first.
 */
export function toUtcDateTime(value: string): string {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  return m ? `${m[1]} ${m[2]}` : value;
}
