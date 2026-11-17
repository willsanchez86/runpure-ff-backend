/** Operator-only GraphQL fields pipelineRuns and ingestLedger (ADR-0017 item 11). */
import { getPool } from '../../../db/pool.js';
import { builder } from '../../../graphql/builder.js';
import { listLedger, recentJobRuns, type JobRunRow, type LedgerRow } from '../model/pipeline.model.js';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const JobRun = builder.objectRef<JobRunRow>('JobRun').implement({
  description: 'One pipeline run (job_run).',
  fields: (fieldBuilder) => ({
    id: fieldBuilder.exposeInt('id'),
    kind: fieldBuilder.exposeString('kind'),
    startedAt: fieldBuilder.string({ resolve: (row) => row.started_at.toISOString() }),
    finishedAt: fieldBuilder.string({ nullable: true, resolve: (row) => iso(row.finished_at) }),
    outcome: fieldBuilder.exposeString('outcome'),
    piecesLoaded: fieldBuilder.exposeInt('pieces_loaded'),
    piecesSkipped: fieldBuilder.exposeInt('pieces_skipped'),
    piecesFailed: fieldBuilder.exposeInt('pieces_failed'),
    error: fieldBuilder.exposeString('error', { nullable: true }),
  }),
});

const LedgerEntry = builder.objectRef<LedgerRow>('IngestLedgerEntry').implement({
  description: 'One loaded piece: a dataset for one season (ingest_ledger).',
  fields: (fieldBuilder) => ({
    dataset: fieldBuilder.exposeString('dataset'),
    season: fieldBuilder.exposeInt('season', { description: '0 for single-file datasets' }),
    sourceUrl: fieldBuilder.exposeString('source_url'),
    sourceEtag: fieldBuilder.exposeString('source_etag', { nullable: true }),
    sourceLastModified: fieldBuilder.exposeString('source_last_modified', { nullable: true }),
    contentLength: fieldBuilder.float({ nullable: true, resolve: (row) => (row.content_length === null ? null : Number(row.content_length)) }),
    status: fieldBuilder.exposeString('status'),
    rowsLoaded: fieldBuilder.exposeInt('rows_loaded', { nullable: true }),
    error: fieldBuilder.exposeString('error', { nullable: true }),
    startedAt: fieldBuilder.string({ resolve: (row) => row.started_at.toISOString() }),
    finishedAt: fieldBuilder.string({ nullable: true, resolve: (row) => iso(row.finished_at) }),
  }),
});

builder.queryFields((fieldBuilder) => ({
  pipelineRuns: fieldBuilder.field({
    type: [JobRun],
    description: 'Most recent pipeline runs, newest first. Operator accounts only.',
    authScopes: { operator: true },
    args: { limit: fieldBuilder.arg.int({ defaultValue: 20, description: '1 to 100' }) },
    resolve: (_root, args) => recentJobRuns(getPool(), Math.min(Math.max(args.limit ?? 20, 1), 100)),
  }),
  ingestLedger: fieldBuilder.field({
    type: [LedgerEntry],
    description: 'Every ledger piece. Operator accounts only.',
    authScopes: { operator: true },
    resolve: () => listLedger(getPool()),
  }),
}));
