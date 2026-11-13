/**
 * Integration tests for the load path against an isolated MySQL schema (ADR-0006 "Confirmation";
 * ETL spec §5.3, §8). Gated on TEST_DATABASE_URL (a runpure_test schema with sql/0001-0012 applied);
 * skipped when unset so unit-only runs need no database. Verifies idempotency, the run lock,
 * crash-safety, atomic rollback, pooled-connection reuse and the upsert path with real data operations.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { findDataset } from './datasets.js';
import { loadPiece } from './load.service.js';
import { releaseLock, tryAcquireLock } from '../../../db/lock.js';

const url = process.env.TEST_DATABASE_URL;
const teamDef = findDataset('teams')!;
const depthDef = findDataset('depth_charts')!;

/** A full team row (every NOT NULL column) for the teams fixture. */
function teamRow(abbr: string, name: string): Record<string, string> {
  return {
    team_abbr: abbr, team_name: name, team_id: '0200', team_nick: name, team_conf: 'NFC',
    team_division: 'NFC West', team_color: '#111111', team_color2: '#222222', team_color3: '#333333',
    team_color4: '#444444', team_logo_wikipedia: 'http://x/w.png', team_logo_espn: 'http://x/e.png',
    team_wordmark: 'http://x/wm.png', team_conference_logo: 'http://x/c.png',
    team_league_logo: 'http://x/l.png', team_logo_squared: 'http://x/s.png',
  };
}

/** A full depth-chart row for the fixture (dt is cast to DATETIME by the mapping). */
function depthRow(team: string, slot: number, rank: number): Record<string, string> {
  return {
    dt: '2026-11-12T10:00:00Z', team, player_name: 'Test Player', espn_id: '12345',
    gsis_id: '00-0012345', pos_grp_id: '16', pos_grp: 'Base 4-3 D', pos_id: '11',
    pos_name: 'Left End', pos_abb: 'LE', pos_slot: String(slot), pos_rank: String(rank),
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

  const count = async (p: Pool, table: string): Promise<number> => {
    const [rows] = await p.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
    return Number(rows[0].n);
  };

  before(() => {
    pool = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 5 });
  });
  after(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM depth_chart');
    await pool.query('DELETE FROM team');
  });

  test('upserts the team table, updating existing rows and deleting none', async () => {
    await loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')]));
    assert.equal(await count(pool, 'team'), 2);

    await loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'Arizona'), teamRow('LAC', 'Chargers')]));
    assert.equal(await count(pool, 'team'), 3); // PIT kept (no delete), LAC added
    const [rows] = await pool.query<RowDataPacket[]>('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']);
    assert.equal(rows[0].team_name, 'Arizona'); // existing row updated
  });

  test('loads idempotently: the same piece loaded twice gives identical tables', async () => {
    const fixture = [teamRow('ARI', 'Cardinals'), teamRow('PIT', 'Steelers')];
    await loadPiece(pool, teamDef, 0, recordsOf(fixture));
    const [first] = await pool.query<RowDataPacket[]>('SELECT * FROM team ORDER BY team_abbr');
    await loadPiece(pool, teamDef, 0, recordsOf(fixture));
    const [second] = await pool.query<RowDataPacket[]>('SELECT * FROM team ORDER BY team_abbr');
    assert.deepEqual(second, first);
  });

  test('blocks a sharp row-count drop before the swap, keeping the previous data (§8)', async () => {
    await loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'A'), teamRow('PIT', 'B')]));
    await assert.rejects(
      // previousRows=10, one staged row -> 1 < 10*0.5, blocked before the upsert.
      () => loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'changed')]), 10),
      /load blocked/,
    );
    assert.equal(await count(pool, 'team'), 2);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']);
    assert.equal(rows[0].team_name, 'A'); // unchanged
  });

  test('rolls back the swap on a foreign-key violation, leaving the target intact (atomicity)', async () => {
    await loadPiece(pool, teamDef, 0, recordsOf([teamRow('ARI', 'A'), teamRow('PIT', 'B')]));
    await loadPiece(pool, depthDef, 2026, recordsOf([depthRow('ARI', 1, 1), depthRow('PIT', 1, 1)]));
    assert.equal(await count(pool, 'depth_chart'), 2);

    await assert.rejects(
      // 'ZZZ' is not in team; the staging->table insert violates the FK after the DELETE, forcing a rollback.
      () => loadPiece(pool, depthDef, 2026, recordsOf([depthRow('ZZZ', 1, 1)])),
    );
    assert.equal(await count(pool, 'depth_chart'), 2); // DELETE rolled back
  });

  test('a mid-load error leaves the target untouched and the pooled connection is reusable', async () => {
    const small = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 1 });
    try {
      await loadPiece(small, teamDef, 0, recordsOf([teamRow('ARI', 'A'), teamRow('PIT', 'B')]));
      await assert.rejects(() => loadPiece(small, teamDef, 0, throwingRecords([teamRow('X', 'x')], 1)));
      assert.equal(await count(small, 'team'), 2); // untouched by the failed load

      // Same single pooled connection: the next load must still succeed (no leftover staging blocks it).
      await loadPiece(small, teamDef, 0, recordsOf([teamRow('ARI', 'Reused')]));
      const [rows] = await small.query<RowDataPacket[]>('SELECT team_name FROM team WHERE team_abbr = ?', ['ARI']);
      assert.equal(rows[0].team_name, 'Reused');
    } finally {
      await small.end();
    }
  });

  test('serializes runs with the named lock (GET_LOCK)', async () => {
    const a = await pool.getConnection();
    const b = await pool.getConnection();
    try {
      assert.equal(await tryAcquireLock(a), true);
      assert.equal(await tryAcquireLock(b), false); // held by a
      await releaseLock(a);
      assert.equal(await tryAcquireLock(b), true); // now free
      await releaseLock(b);
    } finally {
      a.release();
      b.release();
    }
  });
});
