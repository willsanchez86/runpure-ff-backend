/** Assembles the GraphQL schema from every module's fields (ADR-0016). */
import { builder } from './builder.js';
import '../modules/account/graphql/account.graphql.js';
import '../modules/pipeline/graphql/pipeline.graphql.js';

/** The executable schema served at /graphql and printed to schema.graphql. */
export const schema = builder.toSchema();
