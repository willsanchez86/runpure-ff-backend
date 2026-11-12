/** Queries on the users table (ADR-0015; sql/0002_users.sql). */
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** An app account, keyed to its Firebase uid (ADR-0015). */
export interface AppUser {
  id: number;
  firebaseUid: string;
  isOperator: boolean;
}

interface UserRow extends RowDataPacket {
  id: number;
  firebase_uid: string;
  is_operator: number;
}

/** Finds the account for a Firebase uid; undefined when there is none. */
export async function findUserByFirebaseUid(pool: Pool, uid: string): Promise<AppUser | undefined> {
  const [rows] = await pool.query<UserRow[]>(
    'SELECT id, firebase_uid, is_operator FROM users WHERE firebase_uid = ?',
    [uid],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, firebaseUid: row.firebase_uid, isOperator: Number(row.is_operator) === 1 };
}
