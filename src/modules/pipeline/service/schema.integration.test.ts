/**
 * Schema check: the database built from sql/0001-0015 has the structure the decisions require
 * (ADR-0022 to ADR-0029; schema principles review R1, R3, R23, R42, R44) and every column the
 * dataset registry writes exists. Gated on TEST_DATABASE_URL, like the load integration tests.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { datasets } from './datasets.js';
import { getPool, closePool } from '../../../db/pool.js';

const url = process.env.TEST_DATABASE_URL;

/** Every table of the schema, including the pipeline tables and users. */
const ALL_TABLES = ['team', 'player', 'game', 'player_week_stat', 'team_week_stat', 'roster', 'injury_report',
  'snap_count', 'depth_chart', 'play', 'source', 'player_source', 'game_source', 'stadium', 'position_group',
  'position', 'ingest_ledger', 'job_run', 'users'];

/** Foreign keys the decisions require, as `table.column -> parent.column` (composite keys joined by `+`). */
const REQUIRED_FOREIGN_KEYS = [
  'player_week_stat.player_id -> player.gsis_id', 'player_week_stat.game_id -> game.game_id',
  'team_week_stat.game_id -> game.game_id', 'roster.gsis_id -> player.gsis_id',
  'injury_report.gsis_id -> player.gsis_id', 'snap_count.game_id -> game.game_id',
  'snap_count.source_code+pfr_player_id -> player_source.source_code+source_player_id',
  'depth_chart.gsis_id -> player.gsis_id', 'depth_chart.pos_grp_id -> position_group.pos_grp_id',
  'depth_chart.pos_id -> position.pos_id', 'game.away_qb_id -> player.gsis_id', 'game.home_qb_id -> player.gsis_id',
  'game.stadium_id -> stadium.stadium_id', 'play.game_id -> game.game_id',
  'play.passer_player_id -> player.gsis_id', 'play.kicker_player_id -> player.gsis_id', 'play.id -> player.gsis_id',
  'play.solo_tackle_1_player_id -> player.gsis_id', 'play.assist_tackle_4_player_id -> player.gsis_id',
  'play.half_sack_2_player_id -> player.gsis_id', 'play.posteam -> team.team_abbr',
  'player_source.gsis_id -> player.gsis_id', 'player_source.source_code -> source.source_code',
  'game_source.game_id -> game.game_id', 'game_source.source_code -> source.source_code',
];

describe('schema check', { skip: url ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let pool: Pool;
  const query = async (sql: string): Promise<RowDataPacket[]> => (await pool.query<RowDataPacket[]>(sql))[0];

  before(() => {
    pool = mysql.createPool({ uri: url!, supportBigNumbers: true, timezone: 'Z', connectionLimit: 2 });
  });
  after(async () => {
    await pool.end();
    await closePool();
  });

  test('every table exists, has a primary key and carries created_at and updated_at (R1, ADR-0029)', async () => {
    const tables = (await query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')).map((row) => row.name);
    assert.deepEqual([...tables].sort(), [...ALL_TABLES].sort());
    const keyed = new Set((await query("SELECT DISTINCT TABLE_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY'")).map((row) => row.name));
    assert.deepEqual(ALL_TABLES.filter((table) => !keyed.has(table)), []);
    for (const column of ['created_at', 'updated_at']) {
      const stamped = new Set((await query(`SELECT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = '${column}' AND IS_NULLABLE = 'NO'`)).map((row) => row.name));
      assert.deepEqual(ALL_TABLES.filter((table) => !stamped.has(table)), [], `${column} missing`);
    }
  });

  test('the required foreign keys exist, all named for their table (ADR-0022, ADR-0023, ADR-0025, R44)', async () => {
    const rows = await query(
      `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent,
              GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '+') AS child_columns,
              GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '+') AS parent_columns
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY CONSTRAINT_NAME, TABLE_NAME, REFERENCED_TABLE_NAME`,
    );
    const present = new Set(rows.map((row) => `${row.child}.${row.child_columns} -> ${row.parent}.${row.parent_columns}`));
    assert.deepEqual(REQUIRED_FOREIGN_KEYS.filter((key) => !present.has(key)), []);
    assert.equal(rows.length, 85);
    assert.deepEqual(rows.filter((row) => /_ibfk_\d+$/.test(row.name)).map((row) => row.name), []);
    // All 48 player columns of play point at player (26 single-role, 22 numbered slots: ADR-0027).
    assert.equal(rows.filter((row) => row.child === 'play' && row.parent === 'player').length, 48);
    // The 14 numbered slot team columns carry no foreign key: 6 team keys remain on play.
    assert.equal(rows.filter((row) => row.child === 'play' && row.parent === 'team').length, 6);
  });

  test('no table exceeds the 64-index limit, and mapping-table columns are required (R23, R42)', async () => {
    const counts = await query('SELECT TABLE_NAME AS name, COUNT(DISTINCT INDEX_NAME) AS indexes FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME');
    assert.deepEqual(counts.filter((row) => Number(row.indexes) > 64), []);
    assert.equal(Number(counts.find((row) => row.name === 'play')!.indexes), 55);
    const nullable = await query("SELECT TABLE_NAME AS name, COLUMN_NAME AS col FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('player_source', 'game_source', 'source') AND IS_NULLABLE = 'YES'");
    assert.deepEqual(nullable, []);
  });

  test('every column a dataset writes exists on its table; staged-only columns do not (ADR-0026)', async () => {
    for (const def of datasets) {
      const columns = new Set((await query(`SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${def.table}'`)).map((row) => row.col));
      const written = Object.values(def.columns!).map((spec) => (typeof spec === 'string' ? spec : spec.to));
      assert.deepEqual(written.filter((column) => !columns.has(column)), [], `${def.name}: written but missing`);
      assert.deepEqual(Object.keys(def.stageOnly ?? {}).filter((column) => columns.has(column)), [], `${def.name}: staged-only but stored`);
      // Nothing is left behind: apart from the timestamps and columns other loads fill, every column is written.
      const filledElsewhere = new Set(['created_at', 'updated_at', 'source_code', 'start_time', 'weather', 'home_opening_kickoff']);
      assert.deepEqual([...columns].filter((column) => !written.includes(column) && !filledElsewhere.has(column)), [], `${def.name}: stored but never written`);
    }
  });

  test('the provider list is seeded and job_run accepts the reconcile kind (ADR-0023, ADR-0028)', async () => {
    assert.equal(Number((await query('SELECT COUNT(*) AS n FROM source'))[0].n), 17);
    const kind = (await query("SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_run' AND COLUMN_NAME = 'kind'"))[0].type;
    assert.equal(kind, "enum('ingest','backfill','reconcile')");
  });

  test('every pooled application connection runs in UTC (ADR-0029)', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      const [rows] = await getPool().query<RowDataPacket[]>('SELECT @@session.time_zone AS zone');
      assert.equal(rows[0].zone, '+00:00');
    } finally {
      await closePool();
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
