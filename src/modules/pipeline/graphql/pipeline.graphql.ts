/** Operator-only GraphQL fields pipelineRuns and ingestLedger (ADR-0017 item 11). */
import { getPool } from '../../../db/pool.js';
import { builder } from '../../../graphql/builder.js';
import { listLedger, recentJobRuns, type JobRunRow, type LedgerRow } from '../model/pipeline.model.js';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const JobRun = builder.objectRef<JobRunRow>('JobRun').implement({
  description: 'One pipeline run (job_run).',
  fields: (t) => ({
    id: t.exposeInt('id'),
    kind: t.exposeString('kind'),
    startedAt: t.string({ resolve: (r) => r.started_at.toISOString() }),
    finishedAt: t.string({ nullable: true, resolve: (r) => iso(r.finished_at) }),
    outcome: t.exposeString('outcome'),
    piecesLoaded: t.exposeInt('pieces_loaded'),
    piecesSkipped: t.exposeInt('pieces_skipped'),
    piecesFailed: t.exposeInt('pieces_failed'),
    error: t.exposeString('error', { nullable: true }),
  }),
});

const LedgerEntry = builder.objectRef<LedgerRow>('IngestLedgerEntry').implement({
  description: 'One loaded piece: a dataset for one season (ingest_ledger).',
  fields: (t) => ({
    dataset: t.exposeString('dataset'),
    season: t.exposeInt('season', { description: '0 for single-file datasets' }),
    sourceUrl: t.exposeString('source_url'),
    sourceEtag: t.exposeString('source_etag', { nullable: true }),
    sourceLastModified: t.exposeString('source_last_modified', { nullable: true }),
    contentLength: t.float({ nullable: true, resolve: (r) => (r.content_length === null ? null : Number(r.content_length)) }),
    status: t.exposeString('status'),
    rowsLoaded: t.exposeInt('rows_loaded', { nullable: true }),
    error: t.exposeString('error', { nullable: true }),
    startedAt: t.string({ resolve: (r) => r.started_at.toISOString() }),
    finishedAt: t.string({ nullable: true, resolve: (r) => iso(r.finished_at) }),
  }),
});

builder.queryFields((t) => ({
  pipelineRuns: t.field({
    type: [JobRun],
    description: 'Most recent pipeline runs, newest first. Operator accounts only.',
    authScopes: { operator: true },
    args: { limit: t.arg.int({ defaultValue: 20, description: '1 to 100' }) },
    resolve: (_root, args) => recentJobRuns(getPool(), Math.min(Math.max(args.limit ?? 20, 1), 100)),
  }),
  ingestLedger: t.field({
    type: [LedgerEntry],
    description: 'Every ledger piece. Operator accounts only.',
    authScopes: { operator: true },
    resolve: () => listLedger(getPool()),
  }),
}));
