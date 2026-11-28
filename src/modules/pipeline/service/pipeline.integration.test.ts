/**
 * Integration tests for the load path against an isolated MySQL schema (ADR-0006 "Confirmation";
 * ADR-0022 to ADR-0029; ETL spec §5.3, §8). Gated on TEST_DATABASE_URL (a runpure_test schema with
 * sql/0001-0015 applied); skipped when unset so unit-only runs need no database. Covers idempotent
 * upserts, crash-safety, rollback, the ledger committing with the data, publish retries, foreign
 * keys, provider-ID mapping, roster exclusion, re-linking, kept seasons and the reconciliation.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { RELINK_STEPS, findDataset, type DatasetDef } from './datasets.js';
import { relinkAndCount } from './ingest.service.js';
import { loadPiece, stageRecords } from './load.service.js';
import { DownloadError } from './nflverse.service.js';
import { deleteRowsMissingFromFile } from './reconcile.service.js';
import { loadParentKeys, prepareRecords } from './validate.service.js';
import type { LedgerPiece } from '../model/pipeline.model.js';
import { findSeasonGames, findStatPage } from '../../nfl/model/nfl.model.js';

const url = process.env.TEST_DATABASE_URL;
const dataset = (name: string): DatasetDef => findDataset(name)!;
const teamDef = dataset('teams');
const playerDef = dataset('players');
const gameDef = dataset('schedules');
const rosterDef = dataset('rosters');
const statDef = dataset('stats_player_week');
const snapDef = dataset('snap_counts');
const depthDef = dataset('depth_charts');
const playDef = dataset('pbp');

/** Child tables first, so foreign keys allow the cleanup between tests. */
const TABLES_CHILD_FIRST = ['play', 'depth_chart', 'snap_count', 'injury_report', 'roster', 'player_week_stat',
  'team_week_stat', 'game_source', 'player_source', 'game', 'stadium', 'position', 'position_group', 'player', 'team',
  'ingest_ledger'];

/** A team row for the fixture. */
function teamRow(abbr: string, name: string): Record<string, string> {
  return { team_abbr: abbr, team_name: name, team_id: '0200', team_nick: name, team_conf: 'NFC', team_division: 'NFC West' };
}

/** A players.csv row; `ids` adds provider-ID columns. */
function playerRow(gsisId: string, name: string, ids: Record<string, string> = {}): Record<string, string> {
  return { gsis_id: gsisId, display_name: name, position_group: 'QB', position: 'QB', ...ids };
}

/** A games.csv row; `extra` overrides or adds columns. */
function gameRow(gameId: string, season: number, extra: Record<string, string> = {}): Record<string, string> {
  return { game_id: gameId, season: String(season), game_type: 'REG', week: '1', away_team: 'ARI', home_team: 'PIT',
    stadium_id: 'PIT00', stadium: 'Old Name Field', ...extra };
}

/** A depth-chart row (dt is cast to DATETIME by the mapping). */
function depthRow(team: string, slot: number, rank: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    dt: '2026-11-12T10:00:00Z', team, player_name: 'Test Player', espn_id: '12345',
    gsis_id: '00-0000001', pos_grp_id: '16', pos_grp: 'Base 4-3 D', pos_id: '11',
    pos_name: 'Left End', pos_abb: 'LE', pos_slot: String(slot), pos_rank: String(rank), ...extra,
  };
}

/** Yields the rows as an async iterable, like the CSV parser. */
async function* recordsOf(rows: Record<string, string>[]): AsyncGenerator<Record<string, string>> {
  for (const row of rows) yield row;
}

/** Yields `afterN` rows, then throws — simulating a download/parse failure mid-load. */
async function* throwingRecords(rows: Record<string, string>[], afterN: number): AsyncGenerator<Record<string, string>> {
  let yielded = 0;
  for (const row of rows) {
    if (yielded >= afterN) throw new Error('simulated mid-load failure');
    yield row;
    yielded++;
  }
  throw new Error('simulated mid-load failure');
}

describe('pipeline load integration', { skip: url ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let pool: Pool;

  const count = async (table: string, where = '1 = 1'): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`);
    return Number(rows[0].n);
  };
  const rowsOf = async (sql: string, params: unknown[] = []): Promise<RowDataPacket[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows;
  };
  const load = (def: DatasetDef, season: number, rows: Record<string, string>[]) =>
    loadPiece(pool, def, season, recordsOf(rows), null, null, RELINK_STEPS);

  /** Teams, two players (A has a PFR and an ESPN ID) and one 2026 game: the parents most tests need. */
  const loadParents = async (): Promise<void> => {
    await load(teamDef, 0, [teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')]);
    await load(playerDef, 0, [
      playerRow('00-0000001', 'Player A', { pfr_id: 'PlayA00', espn_id: '12345' }),
      playerRow('00-0000002', 'Player B'),
    ]);
    await load(gameDef, 0, [gameRow('2026_01_ARI_PIT', 2026, { home_qb_id: '00-0000001' })]);
  };

  before(() => {
    pool = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 5 });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    for (const table of TABLES_CHILD_FIRST) await pool.query(`DELETE FROM \`${table}\``);
  });

  /** Ledger identity for the depth-chart fixture piece. */
  const depthPiece = (etag: string): LedgerPiece => ({
    dataset: depthDef.name, season: 2026, sourceUrl: 'http://test/depth_charts_2026.csv',
    etag, lastModified: null, contentLength: null,
  });
  const ledgerRow = async (): Promise<RowDataPacket | undefined> =>
    (await rowsOf('SELECT status, source_etag, rows_loaded FROM ingest_ledger WHERE dataset = ? AND season = 2026', [depthDef.name]))[0];

  test('upserts: existing rows updated, rows absent from a later file kept (ADR-0028)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')]);
    await load(teamDef, 0, [teamRow('ARI', 'Arizona'), teamRow('LAC', 'Chargers')]);
    assert.equal(await count('team'), 3); // PIT kept (no delete), LAC added
    assert.equal((await rowsOf('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']))[0].team_name, 'Arizona');
  });

  test('loads idempotently: an unchanged row is not rewritten, so updated_at stays (ADR-0028, ADR-0029)', async () => {
    const fixture = [teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')];
    await load(teamDef, 0, fixture);
    const first = await rowsOf('SELECT * FROM team ORDER BY team_abbr');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await load(teamDef, 0, fixture);
    assert.deepEqual(await rowsOf('SELECT * FROM team ORDER BY team_abbr'), first);
    assert.ok(first[0].created_at instanceof Date && first[0].updated_at instanceof Date);
  });

  test('a changed row gets a later updated_at and keeps its created_at (ADR-0029)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'Cardinals')]);
    const [original] = await rowsOf('SELECT created_at, updated_at FROM team');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await load(teamDef, 0, [teamRow('ARI', 'Arizona')]);
    const [changed] = await rowsOf('SELECT created_at, updated_at FROM team');
    assert.deepEqual(changed.created_at, original.created_at);
    assert.ok(changed.updated_at > original.updated_at);
  });

  test('blocks a sharp row-count drop before publishing, keeping the previous data (§8)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'A'), teamRow('PIT', 'B')]);
    await assert.rejects(() => loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'changed')]), 10), /load blocked/);
    assert.equal((await rowsOf('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']))[0].team_name, 'A');
  });

  test('a foreign-key violation rolls the piece back and is not retried (ADR-0022, ADR-0006)', async () => {
    await loadParents();
    await load(depthDef, 2026, [depthRow('ARI', 1, 1), depthRow('PIT', 1, 1)]);
    // 'ZZZ' is not in team: the upsert violates the foreign key and the whole piece rolls back.
    await assert.rejects(() => load(depthDef, 2026, [depthRow('ARI', 2, 1), depthRow('ZZZ', 1, 1)]), /foreign key constraint/);
    assert.equal(await count('depth_chart'), 2);
    // An unknown player, game or quarterback is rejected the same way.
    await assert.rejects(() => load(statDef, 2026, [{ player_id: '00-0099999', season: '2026', week: '1', season_type: 'REG' }]), /foreign key/);
    await assert.rejects(() => load(snapDef, 2026, [{ game_id: 'no_such_game', pfr_player_id: 'PlayA00' }]), /foreign key/);
    await assert.rejects(() => load(gameDef, 0, [gameRow('2026_02_ARI_PIT', 2026, { away_qb_id: '00-0099999' })]), /foreign key/);
  });

  test('a mid-load error is a DownloadError, leaves the target untouched and the connection reusable', async () => {
    const small = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 1 });
    try {
      await loadPiece(small, teamDef, 0, recordsOf([teamRow('ARI', 'A'), teamRow('PIT', 'B')]));
      await assert.rejects(
        () => loadPiece(small, teamDef, 0, throwingRecords([teamRow('X', 'x')], 1)),
        (err: unknown) => err instanceof DownloadError,
      );
      assert.equal(await count('team'), 2);
      await loadPiece(small, teamDef, 0, recordsOf([teamRow('ARI', 'Reused')]));
      assert.equal((await rowsOf('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']))[0].team_name, 'Reused');
    } finally {
      await small.end();
    }
  });

  test('marks the ledger loaded in the same transaction as the data (ADR-0006)', async () => {
    await loadParents();
    await loadPiece(pool, depthDef, 2026, recordsOf([depthRow('ARI', 1, 1)]), null, depthPiece('v1'));
    const loaded = await ledgerRow();
    assert.equal(loaded?.status, 'loaded');
    assert.equal(loaded?.source_etag, 'v1');
    assert.equal(Number(loaded?.rows_loaded), 1);

    await assert.rejects(() => loadPiece(pool, depthDef, 2026, recordsOf([depthRow('ZZZ', 1, 1)]), null, depthPiece('v2')));
    assert.equal((await ledgerRow())?.source_etag, 'v1'); // the failed publish rolled its ledger write back
  });

  test('a publish blocked by a lock is retried and each failed attempt is reported (ADR-0006)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'A')]);
    const impatient = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 1 });
    impatient.on('connection', (connection) => {
      connection.query('SET innodb_lock_wait_timeout = 1');
    });
    const blocker = await pool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT * FROM team WHERE team_abbr = ? FOR UPDATE', ['ARI']);
      setTimeout(() => void blocker.rollback(), 1600); // the first attempt times out; the lock is gone for the second
      const report = await loadPiece(impatient, teamDef, 0, recordsOf([teamRow('ARI', 'After Lock')]));
      assert.ok(report.notes.some((note) => /publish attempt 1 of 3 failed, retrying/.test(note)));
      assert.equal((await rowsOf('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']))[0].team_name, 'After Lock');
    } finally {
      blocker.release();
      await impatient.end();
    }
  });

  test('overlapping loads of one piece both succeed and the table holds every row', async () => {
    await loadParents();
    const two = [depthRow('ARI', 1, 1), depthRow('PIT', 1, 1)];
    const three = [depthRow('ARI', 1, 1), depthRow('ARI', 2, 1), depthRow('PIT', 1, 1)];
    const results = await Promise.allSettled([
      loadPiece(pool, depthDef, 2026, recordsOf(two), null, depthPiece('two')),
      loadPiece(pool, depthDef, 2026, recordsOf(three), null, depthPiece('three')),
    ]);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(await count('depth_chart'), 3);
    assert.equal((await ledgerRow())?.status, 'loaded');
  });

  test('roster rows for a player missing from player are excluded and counted (ADR-0024)', async () => {
    await loadParents();
    // prepareRecords checks the file header, so the fixture rows carry every mapped roster column.
    const emptyRosterRow = Object.fromEntries(Object.keys(rosterDef.columns!).map((column) => [column, '']));
    const raw = recordsOf([
      { ...emptyRosterRow, season: '2026', team: 'ARI', gsis_id: '00-0000001', position: 'QB' },
      { ...emptyRosterRow, season: '2026', team: 'PIT', gsis_id: '00-0077777', position: 'WR' }, // not in player
    ]);
    const { records, stats } = await prepareRecords(rosterDef, raw, await loadParentKeys(pool, rosterDef));
    await loadPiece(pool, rosterDef, 2026, records);
    assert.equal(stats.excluded, 1);
    assert.equal(await count('roster'), 1);
    assert.equal(await count('player', "gsis_id = '00-0077777'"), 0); // no placeholder player
  });

  test('provider IDs become mapping rows; players.csv wins; shared and taken IDs are not stored (ADR-0023)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'Cardinals')]);
    const players = await load(playerDef, 0, [
      playerRow('00-0000001', 'Player A', { pfr_id: 'PlayA00', espn_id: '111.0', smart_id: 'shared-smart' }),
      playerRow('00-0000002', 'Player B', { smart_id: 'shared-smart' }),
    ]);
    assert.ok(players.warnings.some((warning) => /2 ID\(s\) shared by more than one row/.test(warning)));
    assert.equal(await count('player_source', "source_code = 'smart'"), 0);
    // "111.0" is stored as the text 111 (normalized).
    assert.equal((await rowsOf("SELECT source_player_id FROM player_source WHERE gsis_id = '00-0000001' AND source_code = 'espn'"))[0].source_player_id, '111');

    // The roster fills a provider the player lacks, never replaces one, and can't take another player's ID.
    const roster = await load(rosterDef, 2026, [
      { season: '2026', team: 'ARI', gsis_id: '00-0000001', espn_id: '999', sleeper_id: '4046' },
      { season: '2026', team: 'ARI', gsis_id: '00-0000002', pfr_id: 'PlayA00' },
    ]);
    assert.ok(roster.warnings.some((warning) => /1 ID\(s\) differ from the stored value/.test(warning)));
    assert.ok(roster.warnings.some((warning) => /1 ID\(s\) already held by another row/.test(warning)));
    assert.equal((await rowsOf("SELECT source_player_id FROM player_source WHERE gsis_id = '00-0000001' AND source_code = 'espn'"))[0].source_player_id, '111');
    assert.equal(await count('player_source', "gsis_id = '00-0000001' AND source_code = 'sleeper' AND source_player_id = '4046'"), 1);
    assert.equal(await count('player_source', "gsis_id = '00-0000002'"), 0);

    // players.csv is authoritative: a changed ID replaces the stored one.
    await load(playerDef, 0, [playerRow('00-0000001', 'Player A', { pfr_id: 'PlayA00', espn_id: '222' })]);
    assert.equal((await rowsOf("SELECT source_player_id FROM player_source WHERE gsis_id = '00-0000001' AND source_code = 'espn'"))[0].source_player_id, '222');
  });

  test('two games sharing a provider ID: neither is stored, both reported (ADR-0023)', async () => {
    await load(teamDef, 0, [teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')]);
    const report = await load(gameDef, 0, [
      gameRow('2026_16_ARI_PIT', 2026, { old_game_id: '2026122700', espn: '401' }),
      gameRow('2026_17_ARI_PIT', 2026, { old_game_id: '2026122700', espn: '402' }),
    ]);
    assert.ok(report.warnings.some((warning) => /2 ID\(s\) shared/.test(warning)));
    assert.equal(await count('game_source', "source_code = 'nfl_old'"), 0);
    assert.equal(await count('game_source', "source_code = 'espn'"), 2);
    assert.equal(await count('stadium'), 1);
    assert.equal(await count('game', 'stadium_id IS NOT NULL'), 2);
  });

  test('unidentifiable rows load unlinked, are counted, and link once the ID is known (ADR-0024)', async () => {
    await loadParents();
    await load(snapDef, 2026, [
      { game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayA00', player: 'Player A', offense_snaps: '60' },
      { game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayB00', player: 'Player B', offense_snaps: '12' },
    ]);
    assert.equal(await count('snap_count', "source_code = 'pfr'"), 1);
    assert.equal(await count('snap_count', 'source_code IS NULL'), 1);
    await load(depthDef, 2026, [
      depthRow('ARI', 1, 1, { gsis_id: '', espn_id: '12345' }), // known ESPN ID: filled
      depthRow('ARI', 1, 2, { gsis_id: '', espn_id: '99999' }), // unknown: stays empty
    ]);
    assert.equal((await rowsOf('SELECT gsis_id FROM depth_chart WHERE pos_rank = 1'))[0].gsis_id, '00-0000001');
    assert.equal(await count('depth_chart', 'gsis_id IS NULL'), 1);
    assert.equal(await count('position'), 1);
    assert.equal(await count('position_group'), 1);

    // The player's PFR ID arrives later: the old snap row links, and the leftovers are reported.
    await load(playerDef, 0, [playerRow('00-0000002', 'Player B', { pfr_id: 'PlayB00' })]);
    const summary = { details: [] as string[], warnings: [] as string[] };
    await relinkAndCount(pool, summary);
    assert.equal(await count('snap_count', 'source_code IS NULL'), 0);
    assert.ok(summary.warnings.some((warning) => /depth-chart rows with no GSIS ID: 1/.test(warning)));

    // A reload of the depth chart must not erase the GSIS ID filled from the ESPN ID.
    await load(depthDef, 2026, [depthRow('ARI', 1, 1, { gsis_id: '', espn_id: '12345' })]);
    assert.equal((await rowsOf('SELECT gsis_id FROM depth_chart WHERE pos_rank = 1'))[0].gsis_id, '00-0000001');
  });

  test('a changed PFR ID unlinks the snap rows that pointed at the old one (ADR-0023)', async () => {
    await loadParents();
    await load(snapDef, 2026, [{ game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayA00', player: 'Player A' }]);
    await load(playerDef, 0, [playerRow('00-0000001', 'Player A', { pfr_id: 'PlayA99' })]);
    assert.equal(await count('snap_count', 'source_code IS NULL'), 1); // PlayA00 no longer maps to anyone
  });

  test('copied values survive reloads; play-by-play feeds game; every season is kept (ADR-0013, ADR-0026)', async () => {
    await loadParents();
    await load(gameDef, 0, [gameRow('2027_01_ARI_PIT', 2027)]);
    // The roster fills an empty player column; a later players.csv without it keeps the value.
    await load(rosterDef, 2026, [{ season: '2026', team: 'ARI', gsis_id: '00-0000001', football_name: 'Ace', college: 'State' }]);
    await load(playerDef, 0, [playerRow('00-0000001', 'Player A')]);
    const [player] = await rowsOf("SELECT football_name, college_name FROM player WHERE gsis_id = '00-0000001'");
    assert.deepEqual([player.football_name, player.college_name], ['Ace', 'State']);

    const report = await load(playDef, 2026, [{
      game_id: '2026_01_ARI_PIT', play_id: '40', posteam: 'ARI', passer_player_id: '00-0000001', passer_player_name: 'P.A',
      solo_tackle_1_player_id: '00-0000002', solo_tackle_1_team: 'ZZZ', // slot team codes carry no foreign key (ADR-0027)
      start_time: '9/7/26, 13:02:11', weather: 'Dome', home_opening_kickoff: '1', stadium: 'New Name Field',
      nfl_api_id: 'api-uuid-1', home_team: 'PIT', season: '2026',
    }]);
    assert.ok(report.notes.some((note) => /game rows given start time/.test(note)));
    const [game] = await rowsOf("SELECT stadium, weather, start_time, home_opening_kickoff FROM game WHERE game_id = '2026_01_ARI_PIT'");
    assert.deepEqual([game.stadium, game.weather, Number(game.home_opening_kickoff)], ['New Name Field', 'Dome', 1]);
    assert.equal(await count('game_source', "source_code = 'nfl_api' AND source_game_id = 'api-uuid-1'"), 1);

    // A schedules reload keeps the play-by-play stadium name.
    await load(gameDef, 0, [gameRow('2026_01_ARI_PIT', 2026, { home_qb_id: '00-0000001' })]);
    assert.equal((await rowsOf("SELECT stadium FROM game WHERE game_id = '2026_01_ARI_PIT'"))[0].stadium, 'New Name Field');

    // Loading the next season leaves the previous season's plays in place.
    await load(playDef, 2027, [{ game_id: '2027_01_ARI_PIT', play_id: '40', posteam: 'PIT' }]);
    assert.equal(await count('play'), 2);
    // An unknown player in a numbered slot or a single role is rejected.
    await assert.rejects(() => load(playDef, 2026, [{ game_id: '2026_01_ARI_PIT', play_id: '41', qb_hit_1_player_id: '00-0099999' }]), /foreign key/);
    await assert.rejects(() => load(playDef, 2026, [{ game_id: '2026_01_ARI_PIT', play_id: '41', kicker_player_id: '00-0099999' }]), /foreign key/);
  });

  test('reconciliation deletes only rows missing from the current file, within the piece (ADR-0028)', async () => {
    await loadParents();
    await load(gameDef, 0, [gameRow('2025_01_ARI_PIT', 2025)]);
    const stat = (season: number, week: number): Record<string, string> =>
      ({ player_id: '00-0000001', season: String(season), week: String(week), season_type: 'REG' });
    await load(statDef, 2026, [stat(2026, 1), stat(2026, 2), stat(2026, 3)]);
    await load(statDef, 2025, [stat(2025, 1)]);
    await load(snapDef, 2026, [
      { game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayA00' }, { game_id: '2026_01_ARI_PIT', pfr_player_id: 'Gone00' },
      { game_id: '2025_01_ARI_PIT', pfr_player_id: 'PlayA00' },
    ]);
    await load(depthDef, 2026, [depthRow('ARI', 1, 1), depthRow('ARI', 2, 1), depthRow('PIT', 1, 1, { dt: '2026-12-01T10:00:00Z' })]);

    const conn = await pool.getConnection();
    try {
      // Week 3 is gone from the 2026 file; 2025 is another piece and must not be touched.
      await stageRecords(conn, statDef, 'stat__keys', recordsOf([stat(2026, 1), stat(2026, 2)]), statDef.naturalKey);
      assert.equal(await deleteRowsMissingFromFile(conn, statDef, 2026, 'stat__keys'), 1);
      // Snap counts have no season column: the piece is found through the game's season.
      await stageRecords(conn, snapDef, 'snap__keys', recordsOf([{ game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayA00' }]), snapDef.naturalKey);
      assert.equal(await deleteRowsMissingFromFile(conn, snapDef, 2026, 'snap__keys'), 1);
      // Depth charts: only snapshots inside the file's own date span can be judged missing.
      await stageRecords(conn, depthDef, 'depth__keys', recordsOf([depthRow('ARI', 1, 1)]), depthDef.naturalKey);
      assert.equal(await deleteRowsMissingFromFile(conn, depthDef, 2026, 'depth__keys'), 1);
    } finally {
      conn.destroy();
    }
    assert.equal(await count('player_week_stat'), 3);
    assert.equal(await count('player_week_stat', 'season = 2025'), 1);
    assert.equal(await count('snap_count'), 2);
    assert.equal(await count('depth_chart'), 2); // the December snapshot is outside the file's span
    assert.equal(teamDef.reconcile, undefined); // team, player and game are never reconciled
    assert.equal(playerDef.reconcile, undefined);
    assert.equal(gameDef.reconcile, undefined);
  });

  test('API reads: quarterback names through player, snap share through player_source (ADR-0023, ADR-0026)', async () => {
    await loadParents();
    await load(statDef, 2026, [{ player_id: '00-0000001', season: '2026', week: '1', season_type: 'REG', game_id: '2026_01_ARI_PIT', team: 'PIT' }]);
    await load(snapDef, 2026, [{ game_id: '2026_01_ARI_PIT', pfr_player_id: 'PlayA00', offense_pct: '0.91' }]);
    const games = await findSeasonGames(pool, 2026);
    assert.equal(games[0].home_qb_name, 'Player A');
    assert.equal(games[0].away_qb_name, null);
    const stats = await findStatPage(pool, 2026, '', 0, 10);
    assert.equal(stats.length, 1);
    assert.equal(Number(stats[0].offense_pct), 0.91);
  });
});
