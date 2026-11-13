/** Tests for the column-map builder (ETL spec §7.2.2; ADR-0010). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { columnsFor } from './columns.js';

test('columnsFor builds an identity CSV-header -> MySQL-column map', () => {
  assert.deepEqual(columnsFor(['a', 'b', 'c']), { a: 'a', b: 'b', c: 'c' });
});

test('columnsFor applies a cast to only the named column', () => {
  const up = (v: string): string => v.toUpperCase();
  const map = columnsFor(['a', 'b'], { b: up });
  assert.equal(map.a, 'a');
  const spec = map.b as { to: string; cast: (v: string) => unknown };
  assert.equal(spec.to, 'b');
  assert.equal(spec.cast('x'), 'X');
});

test('columnsFor omits columns not listed (e.g. the fantasy-point exclusion, ADR-0007)', () => {
  const map = columnsFor(['player_id', 'passing_yards']);
  assert.ok(!('fantasy_points' in map));
  assert.deepEqual(Object.keys(map), ['player_id', 'passing_yards']);
});
