/** Environment settings, read and validated once at startup (see .env.example). */
import 'dotenv/config';

/** Reads a numeric variable, or the fallback when unset; throws on a non-number. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

const production = process.env.NODE_ENV === 'production';
const allowArbitrary = process.env.GRAPHQL_ALLOW_ARBITRARY === 'true';
if (production && allowArbitrary) {
  throw new Error('GRAPHQL_ALLOW_ARBITRARY must not be set in production (ADR-0017 item 9)');
}
const authDisabled = process.env.AUTH_MODE === 'disabled';
if (production && authDisabled) {
  throw new Error('AUTH_MODE=disabled must not be set in production (ADR-0015 is the production path)');
}

/** Validated settings; DATABASE_URL is read only when first needed. */
export const env = {
  port: num('PORT', 4000),
  production,

  /** Read lazily so jobs that never touch the database can run without it. */
  databaseUrl(): string {
    const value = process.env.DATABASE_URL;
    if (!value) throw new Error('DATABASE_URL is not set (see .env.example)');
    return value;
  },

  /** The only origin CORS allows (ADR-0014). */
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 300),
  /** Local development only; see .env.example. */
  allowArbitraryOperations: allowArbitrary,
  /** Local development only (owner, 2026-11-17): skip the Firebase token check.
   * Startup refuses this in production; ADR-0015 remains the deployed path. */
  authDisabled,

  timezone: process.env.PIPELINE_TZ ?? 'America/New_York',
  cronSchedules: (process.env.PIPELINE_CRON ?? '0 6 * * *')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean),

  /** Quarterly reconciliation (ADR-0028): 07:30 on January 1, April 1, July 1 and October 1, after the 06:00 run. */
  reconcileCron: process.env.RECONCILE_CRON ?? '30 7 1 1,4,7,10 *',

  currentSeasonOverride: process.env.CURRENT_SEASON ? num('CURRENT_SEASON', 0) : undefined,
  historyStartSeason: num('HISTORY_START_SEASON', 2022),
  loadBatchSize: num('LOAD_BATCH_SIZE', 1000),
  /** A load whose staged row count is below (prior rows x this) is blocked (ETL spec §8). */
  rowCountMinRatio: num('ROW_COUNT_MIN_RATIO', 0.5),

  /** Base URL of nflverse release files; configurable so a mirror needs no redeploy (ETL spec §4.1). */
  releaseBase: process.env.RELEASE_BASE ?? 'https://github.com/nflverse/nflverse-data/releases/download',
  /** Hosts the downloader may fetch from, including every redirect hop (SSRF guard, ETL spec §4.2). */
  releaseHostAllowlist: (process.env.RELEASE_HOST_ALLOWLIST ?? 'github.com,githubusercontent.com')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  /** Attempts for a request that fails on a network error, 5xx or 429 (ADR-0006). */
  fetchAttempts: num('FETCH_ATTEMPTS', 3),
  /** Wait before the second attempt, in ms; doubled before each later one. */
  fetchBackoffMs: num('FETCH_BACKOFF_MS', 2000),
  /** Abort a download whose response headers don't arrive within this many ms. */
  downloadHeaderTimeoutMs: num('DOWNLOAD_HEADER_TIMEOUT_MS', 30000),
  /** Abort a download that goes this many ms with no data (stall guard, not a whole-download deadline). */
  downloadIdleTimeoutMs: num('DOWNLOAD_IDLE_TIMEOUT_MS', 60000),
  /** Abort a download exceeding this many bytes. */
  maxDownloadBytes: num('MAX_DOWNLOAD_BYTES', 1_073_741_824),
  /** Abort a gzip stream decompressing beyond this many bytes (decompression-bomb guard). */
  maxDecompressedBytes: num('MAX_DECOMPRESSED_BYTES', 1_073_741_824),
};
