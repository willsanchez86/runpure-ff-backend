/** GraphQL Yoga server with trusted documents and operation logging (ADR-0017 items 5, 7, 9). */
import type { Request, Response } from 'express';
import { createYoga, type Plugin } from 'graphql-yoga';
import { usePersistedOperations } from '@graphql-yoga/plugin-persisted-operations';
import { env } from '../config/env.js';
import type { GraphQLContext } from './builder.js';
import { loadPersistedStore } from './persisted-store.js';
import { schema } from './schema.js';

/**
 * Logs each operation's name and its errors, because GraphQL reports failures inside
 * an HTTP 200 response (ADR-0017 item 5).
 */
const logOperations: Plugin = {
  onExecute({ args }) {
    const name = args.operationName ?? 'anonymous';
    return {
      onExecuteDone({ result }) {
        if (Symbol.asyncIterator in result) return;
        if (result.errors?.length) {
          console.error(`graphql ${name}: ${result.errors.length} error(s)`, result.errors.map((e) => e.message));
        } else {
          console.log(`graphql ${name}: ok`);
        }
      },
    };
  },
};

/** Options for createGraphQLServer. */
export interface GraphQLServerOptions {
  /** Accept operations outside the trusted documents. Default: env (local dev only). */
  allowArbitraryOperations?: boolean;
}

/** GraphQL Yoga mounted on Express (ADR-0017 item 7). Expects req.user to be set. */
export function createGraphQLServer(options: GraphQLServerOptions = {}) {
  const store = loadPersistedStore();
  const allowArbitrary = options.allowArbitraryOperations ?? env.allowArbitraryOperations;

  return createYoga<{ req: Request; res: Response }, GraphQLContext>({
    schema,
    graphqlEndpoint: '/graphql',
    // GraphiQL sends arbitrary operations, which trusted documents refuse.
    graphiql: false,
    // CORS is set by the cors middleware (src/routes/index.ts). Yoga's own CORS, on by
    // default, would overwrite it with whatever origin the request names (ADR-0014).
    cors: false,
    context: ({ req }) => {
      if (!req.user) throw new Error('GraphQL reached without a signed-in user');
      return { user: req.user };
    },
    plugins: [
      usePersistedOperations({
        getPersistedOperation: (key: string) => store.get(key) ?? null,
        allowArbitraryOperations: () => allowArbitrary,
      }),
      logOperations,
    ],
  });
}
