import { builder } from './builder.js';
import '../modules/account/graphql/account.graphql.js';
import '../modules/pipeline/graphql/pipeline.graphql.js';

export const schema = builder.toSchema();
