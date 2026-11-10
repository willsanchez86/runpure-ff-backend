/** Prints the contract to schema.graphql (ADR-0016 item 1). Commit the file with the change. */
import { writeFileSync } from 'node:fs';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { schema } from './schema.js';

writeFileSync('schema.graphql', `${printSchema(lexicographicSortSchema(schema))}\n`);
console.log('wrote schema.graphql');
