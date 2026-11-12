/** Logs each HTTP request's method, path, status and duration. */
import type { NextFunction, Request, Response } from 'express';

/** Logs the request once its response finishes. */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
}
