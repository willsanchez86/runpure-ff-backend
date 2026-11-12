/** MySQL named lock that keeps pipeline runs from overlapping (ADR-0006; ETL spec §5.3). */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/** Named MySQL lock shared by scheduled and backfill runs (ADR-0006). Held per connection. */
export const PIPELINE_LOCK_NAME = 'runpure_pipeline_run';

/** Takes the lock without waiting; true if taken. Release it on the same connection. */
export async function tryAcquireLock(conn: PoolConnection, name = PIPELINE_LOCK_NAME): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [name]);
  return Number(rows[0]?.got) === 1;
}

/** Releases the lock this connection holds. */
export async function releaseLock(conn: PoolConnection, name = PIPELINE_LOCK_NAME): Promise<void> {
  await conn.query('SELECT RELEASE_LOCK(?)', [name]);
}
