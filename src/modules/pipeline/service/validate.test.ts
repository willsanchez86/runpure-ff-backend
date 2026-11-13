/** Tests for load-time validation and row handling (ETL spec §8, §7.2.3). */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatasetDef } from './datasets.js';
import { assertHeader, sanitize, type SanitizeStats } from './validate.service.js';

/** Builds a partial DatasetDef for a test. */
function def(partial: Partial<DatasetDef>): DatasetDef {
  return partial as DatasetDef;
}

/** Runs sanitize over in-memory rows and returns the survivors plus the stats. */
async function run(
  d: DatasetDef,
  rows: Record<string, string>[],
): Promise<{ out: Record<string, string>[]; stats: SanitizeStats }> {
  const stats: SanitizeStats = { dropped: 0, deduped: 0, dedupedNoTiebreaker: 0 };
  async function* source(): AsyncGenerator<Record<string, string>> {
    for (const r of rows) yield r;
  }
  const out: Record<string, string>[] = [];
  for await (const r of sanitize(d, source(), stats)) out.push(r);
  return { out, stats };
}

test('assertHeader accepts either injuries header and ignores extra columns', () => {
  const d = def({ name: 'injuries', columns: { a: 'a', b: 'b', date_modified: 'date_modified', season_type: 'season_type' }, optionalColumns: ['date_modified', 'season_type'] });
  assert.doesNotThrow(() => assertHeader(d, ['a', 'b', 'date_modified'])); // 2022-2024 header
  assert.doesNotThrow(() => assertHeader(d, ['a', 'b', 'season_type'])); // 2025+ header
  assert.doesNotThrow(() => assertHeader(d, ['a', 'b', 'date_modified', 'extra'])); // extra ignored
});

test('assertHeader blocks when a required mapped column is missing', () => {
  const d = def({ name: 't', columns: { a: 'a', b: 'b' } });
  assert.throws(() => assertHeader(d, ['a']), /missing mapped column\(s\): b/);
});

test('sanitize drops rows whose natural key is empty or NA', async () => {
  const d = def({ name: 't', naturalKey: ['k'] });
  const { out, stats } = await run(d, [{ k: '1' }, { k: '' }, { k: 'NA' }, { k: '2' }]);
  assert.deepEqual(out.map((r) => r.k), ['1', '2']);
  assert.equal(stats.dropped, 2);
  assert.equal(stats.deduped, 0);
});

test('sanitize dedupes a repeated key keeping the greatest dedupeBy (latest report wins)', async () => {
  const d = def({ name: 'injuries', naturalKey: ['k'], dedupeBy: 'ts' });
  const { out, stats } = await run(d, [
    { k: '1', ts: '2024-09-04T10:00:00Z', v: 'early' },
    { k: '1', ts: '2024-09-06T12:00:00Z', v: 'late' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 'late');
  assert.equal(stats.deduped, 1);
  assert.equal(stats.dedupedNoTiebreaker, 0);
});

test('sanitize with no dedupeBy value keeps the last row in file order and counts it (2025+ injuries)', async () => {
  const d = def({ name: 'injuries', naturalKey: ['k'], dedupeBy: 'ts' });
  const { out, stats } = await run(d, [
    { k: '1', v: 'first' },
    { k: '1', v: 'second' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 'second');
  assert.equal(stats.deduped, 1);
  assert.equal(stats.dedupedNoTiebreaker, 1);
});
