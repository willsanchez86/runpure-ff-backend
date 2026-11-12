/** Firebase ID-token check in front of the GraphQL endpoint (ADR-0015; ADR-0017 item 2). */
import type { NextFunction, Request, Response } from 'express';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getPool } from '../db/pool.js';
import { findUserByFirebaseUid, type AppUser } from '../modules/account/model/user.model.js';

declare global {
  namespace Express {
    interface Request {
      /** The signed-in account, set by requireUser. */
      user?: AppUser;
    }
  }
}

function firebaseAuth() {
  // Credentials come from GOOGLE_APPLICATION_CREDENTIALS, a key file outside the repo (ADR-0015).
  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  return getAuth();
}

/**
 * Runs before the GraphQL endpoint (ADR-0015, ADR-0017 item 2): verifies the Firebase ID
 * token, then finds the account keyed to its uid. No valid token: 401. No account: 403.
 */
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
  if (!match) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  let uid: string;
  try {
    uid = (await firebaseAuth().verifyIdToken(match[1])).uid;
  } catch {
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  const user = await findUserByFirebaseUid(getPool(), uid);
  if (!user) {
    res.status(403).json({ error: 'no account for this sign-in' });
    return;
  }
  req.user = user;
  next();
}
