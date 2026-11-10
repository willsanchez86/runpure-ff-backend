import mysql, { type Pool } from 'mysql2/promise';
import { env } from '../config/env.js';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.databaseUrl(),
      waitForConnections: true,
      connectionLimit: 10,
      supportBigNumbers: true,
      // DATETIME values are UTC (ETL spec Â§7.2.2); read and write them as UTC.
      timezone: 'Z',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
