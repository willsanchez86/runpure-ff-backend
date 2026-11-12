/** Last Express handlers: 404 for unmatched routes, 500 for unhandled errors. */
import type { NextFunction, Request, Response } from 'express';

/** Answers 404 for any route not matched. */
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

/** Logs an unhandled error and answers 500. Express 5 also forwards rejected promises from async handlers here. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
}
