/**
 * ADR-0017 item 7: the first build step is a spike proving GraphQL Yoga runs on this
 * Express 5 app; if it fails, the fallback is Apollo Server 5 with @as-integrations/express5.
 * Mounts Yoga on Express 5 with a stand-in user (no Firebase, no database), sends one
 * real HTTP request, and reports the result. Usage: npm run spike
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createGraphQLServer } from '../graphql/server.js';
import '../middleware/auth.js'; // declares req.user

function standInUser(req: Request, _res: Response, next: NextFunction): void {
  req.user = { id: 0, firebaseUid: 'spike', isOperator: false };
  next();
}

const app = express();
const yoga = createGraphQLServer({ allowArbitraryOperations: true });
// Wrapped as in src/routes/index.ts: Yoga's call signatures don't fit Express 5's overloads.
app.use(yoga.graphqlEndpoint, standInUser, async (req: Request, res: Response) => {
  await yoga(req, res);
});

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const { port } = server.address() as AddressInfo;

try {
  const res = await fetch(`http://127.0.0.1:${port}${yoga.graphqlEndpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ me { id isOperator } }' }),
  });
  const body = (await res.json()) as { data?: { me?: { id: string } }; errors?: unknown };
  if (res.status === 200 && body.data?.me?.id === '0') {
    console.log('SPIKE PASSED: GraphQL Yoga answered through Express 5.', JSON.stringify(body));
  } else {
    console.error(`SPIKE FAILED: HTTP ${res.status}`, JSON.stringify(body));
    process.exitCode = 1;
  }
} finally {
  server.close();
}
