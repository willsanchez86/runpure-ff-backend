/** Shared mysql2 connection pool, created on first use (ADR-0010). */
import mysql, { type Pool } from 'mysql2/promise';
import { env } from '../config/env.js';

let pool: Pool | undefined;

/** Returns the shared pool, creating it on first call. DATETIME values are read and written as UTC. */
export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.databaseUrl(),
      waitForConnections: true,
      connectionLimit: 10,
      supportBigNumbers: true,
      // DATETIME values are UTC (ETL spec §7.2.2); read and write them as UTC.
      timezone: 'Z',
    });
    // CURRENT_TIMESTAMP fills created_at and updated_at from the session clock, so every
    // connection runs in UTC (ADR-0029). The statement is queued ahead of the connection's first use.
    pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

/** Ends the pool; the next getPool call creates a new one. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}
