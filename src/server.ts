/** Process entry: HTTP server, in-process scheduler and graceful shutdown (ADR-0008). */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';

const app = createApp();
const server = app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port} (GraphQL at /graphql)`);
});

startScheduler();

// ADR-0008: on a shutdown signal, stop starting new runs; an interrupted run is redone
// safely because loads go to a staging table and are swapped in one transaction.
function shutdown(signal: string): void {
  console.log(`${signal} received: shutting down`);
  stopScheduler();
  server.close(() => {
    closePool()
      .catch((err) => console.error('error closing pool', err))
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
