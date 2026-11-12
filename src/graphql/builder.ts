/** Pothos schema builder and the per-request context (ADR-0017 items 1, 8, 11). */
import SchemaBuilder from '@pothos/core';
import ScopeAuthPlugin from '@pothos/plugin-scope-auth';
import type { AppUser } from '../modules/account/model/user.model.js';

/** Context passed to every resolver. */
export interface GraphQLContext {
  /** Set by the token middleware before the request reaches GraphQL (ADR-0017 item 2). */
  user: AppUser;
}

/**
 * Code-first schema (ADR-0017 item 8). Authorization stays in the services (item 1);
 * the `operator` scope guards the operator fields (item 11).
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  AuthScopes: { operator: boolean };
}>({
  plugins: [ScopeAuthPlugin],
  scopeAuth: {
    authScopes: async (ctx) => ({ operator: ctx.user.isOperator }),
  },
});

builder.queryType({});
