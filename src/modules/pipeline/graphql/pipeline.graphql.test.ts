/**
 * Resolver-level test for the operator-only fields pipelineRuns and ingestLedger (ADR-0017 item 11).
 * Executes the real schema with an injected context, so the @pothos/plugin-scope-auth `operator`
 * guard is exercised. Gated to the test database (getPool() reads DATABASE_URL) so it never touches
 * production; skipped unless DATABASE_URL is the runpure_test schema in TEST_DATABASE_URL.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { graphql } from 'graphql';
import { schema } from '../../../graphql/schema.js';
import { closePool, getPool } from '../../../db/pool.js';
import { finishJobRun, startJobRun, upsertLedger } from '../model/pipeline.model.js';

const testUrl = process.env.TEST_DATABASE_URL;
const onTestDb = Boolean(testUrl) && process.env.DATABASE_URL === testUrl;

const QUERY = '{ pipelineRuns(limit: 5) { id outcome } ingestLedger { dataset season } }';
const context = (isOperator: boolean): unknown => ({ user: { id: 1, firebaseUid: 'test', isOperator } });

describe('operator GraphQL fields', { skip: onTestDb ? false : 'set DATABASE_URL=TEST_DATABASE_URL (runpure_test) to run' }, () => {
  before(async () => {
    const pool = getPool();
    const id = await startJobRun(pool, 'ingest');
    await finishJobRun(pool, id, 'ok', { loaded: 1, skipped: 0, failed: 0 });
    await upsertLedger(pool, {
      dataset: 'teams', season: 0, sourceUrl: 'https://example/teams.csv', etag: 'x',
      lastModified: null, contentLength: null, status: 'loaded', rowsLoaded: 36, error: null,
    });
  });
  after(async () => {
    await closePool();
  });

  test('an operator account sees pipelineRuns and ingestLedger', async () => {
    const res = await graphql({ schema, source: QUERY, contextValue: context(true) });
    assert.equal(res.errors, undefined);
    const data = res.data as { pipelineRuns: unknown[]; ingestLedger: unknown[] };
    assert.ok(Array.isArray(data.pipelineRuns) && data.pipelineRuns.length >= 1);
    assert.ok(Array.isArray(data.ingestLedger) && data.ingestLedger.length >= 1);
  });

  test('a non-operator account is denied both fields', async () => {
    const res = await graphql({ schema, source: QUERY, contextValue: context(false) });
    assert.ok(res.errors && res.errors.length >= 1);
    assert.equal((res.data as { pipelineRuns: unknown } | null)?.pipelineRuns ?? null, null);
  });
});
