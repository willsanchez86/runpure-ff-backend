import type { Request, Response } from 'express';
import { getPool } from '../../../db/pool.js';

export async function getHealth(_req: Request, res: Response): Promise<void> {
  await getPool().query('SELECT 1');
  res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
}
