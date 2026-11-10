import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const production = process.env.NODE_ENV === 'production';
const allowArbitrary = process.env.GRAPHQL_ALLOW_ARBITRARY === 'true';
if (production && allowArbitrary) {
  throw new Error('GRAPHQL_ALLOW_ARBITRARY must not be set in production (ADR-0017 item 9)');
}

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

  timezone: process.env.PIPELINE_TZ ?? 'America/New_York',
  cronSchedules: (process.env.PIPELINE_CRON ?? '0 6 * * *')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean),

  currentSeasonOverride: process.env.CURRENT_SEASON ? num('CURRENT_SEASON', 0) : undefined,
  historyStartSeason: num('HISTORY_START_SEASON', 2022),
  loadBatchSize: num('LOAD_BATCH_SIZE', 1000),
};
