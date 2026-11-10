import type { Express } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { createGraphQLServer } from '../graphql/server.js';
import { requireUser } from '../middleware/auth.js';
import { healthRoutes } from '../modules/health/routes/health.routes.js';

export function mountRoutes(app: Express): void {
  // Plain probe for the host; not part of the API.
  app.use('/health', healthRoutes);

  // The API: one GraphQL endpoint (ADR-0017). CORS for the frontend's origin only
  // (ADR-0014), then the rate limit, then the token check (ADR-0015), then Yoga.
  const yoga = createGraphQLServer();
  app.use(
    yoga.graphqlEndpoint,
    cors({ origin: env.frontendOrigin }),
    rateLimit({ windowMs: 60_000, limit: env.rateLimitPerMinute }),
    requireUser,
    yoga,
  );
}
