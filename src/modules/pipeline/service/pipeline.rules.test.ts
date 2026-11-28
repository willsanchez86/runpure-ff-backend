/**
 * Unit and source checks for the pipeline's decided rules: load order, column maps, retries, the
 * stored run log, schedules, and statements the code must never contain (ADR-0006, ADR-0022 to
 * ADR-0029; schema principles review R30, R32, R48). No database needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAY_COLUMNS,
  PLAY_GAME_LEVEL_COLUMNS,
  PLAY_PLAYER_NAME_COLUMNS,
  PLAY_TO_GAME_COLUMNS,
  ROSTER_COLUMNS,
} from './dataset-columns.js';
import { datasets, findDataset } from './datasets.js';
import { storedRunLog } from './ingest.service.js';
import { PUBLISH_ATTEMPTS, normalizeSourceId } from './load.service.js';
import { DownloadError, isTransientStatus, retryTransient } from './nflverse.service.js';
import { scheduledJobs } from '../../../scheduler/index.js';

const sourceRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Every non-test TypeScript source file under src, with its text. */
function sourceFiles(directory: string = sourceRoot): { path: string; text: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [{ path, text: readFileSync(path, 'utf8') }];
  });
}

/** The table columns a dataset writes. */
const writtenColumns = (name: string): string[] =>
  Object.values(findDataset(name)!.columns!).map((spec) => (typeof spec === 'string' ? spec : spec.to));

test('datasets load parents before the tables that reference them (ADR-0022)', () => {
  assert.deepEqual(datasets.map((dataset) => dataset.name), [
    'teams', 'players', 'schedules', 'rosters', 'stats_player_week', 'stats_team_week', 'injuries',
    'snap_counts', 'depth_charts', 'pbp',
  ]);
});

test('no dataset writes a column the schema dropped (ADR-0023, ADR-0025, ADR-0026)', () => {
  const dropped: Record<string, string[]> = {
    players: ['esb_id', 'nfl_id', 'pfr_id', 'pff_id', 'otc_id', 'espn_id', 'smart_id'],
    schedules: ['old_game_id', 'gsis', 'nfl_detail_id', 'pfr', 'pff', 'espn', 'ftn', 'away_qb_name', 'home_qb_name'],
    stats_player_week: ['player_name', 'player_display_name', 'headshot_url'],
    injuries: ['full_name', 'first_name', 'last_name'],
    snap_counts: ['pfr_game_id', 'season', 'week', 'game_type'],
    depth_charts: ['pos_grp', 'pos_name', 'pos_abb'],
    rosters: ['full_name', 'first_name', 'last_name', 'football_name', 'birth_date', 'college', 'rookie_year',
      'entry_year', 'draft_number', 'draft_club', 'espn_id', 'sportradar_id', 'yahoo_id', 'rotowire_id', 'pff_id',
      'pfr_id', 'fantasy_data_id', 'sleeper_id', 'esb_id', 'gsis_it_id', 'smart_id'],
    pbp: [...PLAY_GAME_LEVEL_COLUMNS, ...PLAY_PLAYER_NAME_COLUMNS, ...PLAY_TO_GAME_COLUMNS],
  };
  for (const [name, columns] of Object.entries(dropped)) {
    const written = new Set(writtenColumns(name));
    assert.deepEqual(columns.filter((column) => written.has(column)), [], `${name} still writes dropped columns`);
  }
});

test('the kept columns are still written (ADR-0026, ADR-0027)', () => {
  assert.ok(['position', 'position_group'].every((column) => writtenColumns('stats_player_week').includes(column)));
  assert.equal(writtenColumns('rosters').length, 15);
  assert.ok(['player', 'position'].every((column) => writtenColumns('snap_counts').includes(column)));
  const play = writtenColumns('pbp');
  assert.equal(play.length, 296);
  // The numbered slot columns stay on play: player IDs, team codes and fumble-recovery yards.
  assert.ok(['solo_tackle_1_player_id', 'assist_tackle_4_team', 'fumble_recovery_2_yards', 'drive_play_count',
    'fixed_drive_result'].every((column) => play.includes(column)));
});

test('every column list entry the registry removes exists in its file header list', () => {
  const play = new Set<string>(PLAY_COLUMNS);
  const removedFromPlay = [...PLAY_GAME_LEVEL_COLUMNS, ...PLAY_PLAYER_NAME_COLUMNS, ...PLAY_TO_GAME_COLUMNS];
  assert.deepEqual(removedFromPlay.filter((column) => !play.has(column)), []);
  assert.equal(new Set(removedFromPlay).size, 76);
  assert.equal(ROSTER_COLUMNS.length, 36);
});

test('play-by-play and depth charts start in 2026 and keep every season (ADR-0013)', () => {
  for (const name of ['pbp', 'depth_charts']) {
    assert.equal(findDataset(name)!.scope, 'history');
    assert.equal(findDataset(name)!.startSeason, 2026);
  }
});

test('team, player and game are never reconciled; every fact dataset is (ADR-0028)', () => {
  const unreconciled = datasets.filter((dataset) => !dataset.reconcile).map((dataset) => dataset.name);
  assert.deepEqual(unreconciled, ['teams', 'players', 'schedules']);
});

test('retryTransient retries a DownloadError up to the attempt limit, then throws it (ADR-0006)', async () => {
  let calls = 0;
  const retries: string[] = [];
  const result = await retryTransient(async () => {
    calls++;
    if (calls < 3) throw new DownloadError('HTTP 503');
    return 'done';
  }, 3, 1, (message) => retries.push(message));
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);

  calls = 0;
  await assert.rejects(() => retryTransient(async () => {
    calls++;
    throw new DownloadError('HTTP 500');
  }, 3, 1), DownloadError);
  assert.equal(calls, 3);
});

test('retryTransient does not retry other errors (HTTP 404, a disallowed host)', async () => {
  let calls = 0;
  await assert.rejects(() => retryTransient(async () => {
    calls++;
    throw new Error('GET blocked to disallowed URL');
  }, 3, 1), /disallowed/);
  assert.equal(calls, 1);
  assert.deepEqual([500, 503, 429, 404, 403, 200].map(isTransientStatus), [true, true, true, false, false, false]);
});

test('a publish is tried three times in total: the first try plus two retries (ADR-0006)', () => {
  assert.equal(PUBLISH_ATTEMPTS, 3);
});

test('normalizeSourceId stores provider IDs as plain text (ADR-0023)', () => {
  assert.equal(normalizeSourceId('44822.0'), '44822');
  assert.equal(normalizeSourceId(' MahoPa00 '), 'MahoPa00');
  assert.equal(normalizeSourceId('32004d41-4840-1939-e4c1-bb89191b4e71'), '32004d41-4840-1939-e4c1-bb89191b4e71');
  assert.equal(normalizeSourceId('3139477'), '3139477');
});

test('storedRunLog keeps warnings and every detail line for the run record (ADR-0006)', () => {
  assert.equal(storedRunLog({ details: [], warnings: [] }), null);
  const text = storedRunLog({ details: ['rosters 2026: loaded 3000 rows, excluded 158 (gsis_id not in player)'], warnings: ['snap-count rows with an unknown PFR ID: 54'] })!;
  assert.ok(text.startsWith('WARNINGS:\nsnap-count rows'));
  assert.ok(text.includes('LOG:\nrosters 2026: loaded 3000 rows, excluded 158'));
  assert.ok(storedRunLog({ details: ['x'.repeat(70000)], warnings: [] })!.length < 60100);
});

test('the scheduler runs the daily ingest and the quarterly reconciliation (ADR-0008, ADR-0028)', () => {
  const jobs = scheduledJobs();
  assert.ok(jobs.some((job) => job.name === 'ingest' && job.expression === '0 6 * * *'));
  const reconcile = jobs.find((job) => job.name === 'reconcile')!;
  // 07:30 on day 1 of January, April, July and October: after the 06:00 run.
  assert.equal(reconcile.expression, '30 7 1 1,4,7,10 *');
});

test('source check: no table locks, named locks or disabled foreign-key checks (R30, R48, ADR-0006)', () => {
  for (const { path, text } of sourceFiles()) {
    assert.ok(!/LOCK TABLES|GET_LOCK|RELEASE_LOCK|foreign_key_checks/i.test(text), path);
  }
});

test('source check: no INSERT IGNORE; mapping tables are never upserted by ON DUPLICATE KEY (R32)', () => {
  for (const { path, text } of sourceFiles()) {
    assert.ok(!/INSERT\s+IGNORE/i.test(text), path);
    assert.ok(!/INSERT INTO (player_source|game_source)[^;`]*ON DUPLICATE KEY/is.test(text), path);
  }
});

test('source check: only the reconciliation deletes rows; the load path has no DELETE (ADR-0028)', () => {
  const deleting = sourceFiles()
    .filter(({ text }) => /\bDELETE\b[^'"`\n]*\bFROM\b/i.test(text))
    .map(({ path }) => path.replaceAll('\\', '/').split('/src/')[1]);
  assert.deepEqual(deleting, ['modules/pipeline/service/reconcile.service.ts']);
});
