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
  const d = new Date(`${seasonOpenerSwitch(2026)}T00:00:00Z`);
  assert.equal(d.getUTCMonth(), 8); // September
  assert.equal(d.getUTCDay(), 3); // Wednesday
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

test('seasonsToLoad loads only the current season for an incremental history run', () => {
  const seasons = seasonsToLoad(def({ scope: 'history' }), 'ingest');
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0], currentSeason('season_opener'));
});
