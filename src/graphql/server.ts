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
