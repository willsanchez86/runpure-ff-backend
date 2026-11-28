/** Tests for the current-season rule and season expansion (ETL spec D6; ADR-0006, ADR-0013). */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatasetDef } from './datasets.js';
import { SINGLE_FILE_SEASON, currentSeason, seasonOpenerSwitch, seasonsToLoad } from './season.js';

/** Builds a partial DatasetDef for a test. */
function def(partial: Partial<DatasetDef>): DatasetDef {
  return partial as DatasetDef;
}

test('seasonOpenerSwitch is a Wednesday in September', () => {
  const openerDate = new Date(`${seasonOpenerSwitch(2026)}T00:00:00Z`);
  assert.equal(openerDate.getUTCMonth(), 8); // September
  assert.equal(openerDate.getUTCDay(), 3); // Wednesday
});

test('currentSeason follows the March 15 rollover for rosters', () => {
  assert.equal(currentSeason('march_15', new Date('2026-01-15T12:00:00Z')), 2025);
  assert.equal(currentSeason('march_15', new Date('2026-06-15T12:00:00Z')), 2026);
});

test('currentSeason follows the season-opener rollover for other datasets', () => {
  assert.equal(currentSeason('season_opener', new Date('2026-01-15T12:00:00Z')), 2025);
  assert.equal(currentSeason('season_opener', new Date('2026-11-15T12:00:00Z')), 2026);
});

test('seasonsToLoad returns the single-file season for single files', () => {
  assert.deepEqual(seasonsToLoad(def({ scope: 'single_file' }), 'backfill'), [SINGLE_FILE_SEASON]);
});

test('seasonsToLoad expands a backfill range for history datasets', () => {
  assert.deepEqual(
    seasonsToLoad(def({ scope: 'history' }), 'backfill', { from: 2022, to: 2024 }),
    [2022, 2023, 2024],
  );
});

test('a scheduled run covers every season from the history start to the current one (ADR-0006)', () => {
  const seasons = seasonsToLoad(def({ scope: 'history' }), 'ingest');
  const current = currentSeason('season_opener');
  assert.equal(seasons[0], 2022);
  assert.equal(seasons.at(-1), current);
  assert.equal(seasons.length, current - 2022 + 1);
});

test('a dataset with its own first season starts there, for every kind of run (ADR-0013)', () => {
  const current = currentSeason('season_opener');
  assert.equal(seasonsToLoad(def({ scope: 'history', startSeason: 2026 }), 'ingest')[0], Math.min(2026, current + 1));
  assert.deepEqual(seasonsToLoad(def({ scope: 'history', startSeason: 2026 }), 'backfill', { from: 2022, to: 2027 }), [2026, 2027]);
});
