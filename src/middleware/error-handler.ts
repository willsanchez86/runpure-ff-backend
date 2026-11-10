import type { NextFunction, Request, Response } from 'express';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

// Express 5 forwards rejected promises from async handlers here.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
}
