/**
 * nflverse dataset registry: the Phase 1 datasets (ETL spec D2) plus the team file (D9a).
 * Weekly rosters are not loaded (D2).
 *
 * Each entry names one published release file per season (or one file in total).
 * `scope` decides which seasons are loaded:
 *   history     - one file per season, from HISTORY_START_SEASON (or the dataset's `startSeason`)
 *                 to the current season; every season is kept (ADR-0006, ADR-0013)
 *   single_file - one file covering all seasons
 * `rollover` decides when a seasonal dataset moves to the new season (D6):
 *   march_15       - season rosters
 *   season_opener  - everything else: the Wednesday after Labor Day (default)
 *
 * Order matters: datasets load parents first, because MySQL checks every foreign key on each
 * statement (ADR-0022): teams, players, schedules, rosters, weekly stats and injuries, snap counts,
 * depth charts, play-by-play. Every dataset is loaded by upsert; no load deletes rows (ADR-0028).
 *
 * `columns` is the hand-written mapping (ADR-0010) from CSV header to the table's own columns.
 * `stageOnly` lists CSV columns the load needs but the table does not store (provider IDs, lookup
 * names, game facts carried by play-by-play); they are staged and written elsewhere by `before`,
 * `after` and `sourceIds` (ADR-0023, ADR-0025, ADR-0026). The load engine is generic: behaviour that
 * differs between datasets is declared here as data, never as a branch in the engine.
 *
 * File paths from the ETL spec §4.1.
 */

import { toUtcDateTime } from './casts.js';
import { columnsFor } from './columns.js';
import {
  DEPTH_CHART_COLUMNS,
  DEPTH_CHART_LOOKUP_COLUMNS,
  GAME_COLUMNS,
  GAME_SOURCE_ID_COLUMNS,
  INJURY_REPORT_COLUMNS,
  PLAY_COLUMNS,
  PLAY_GAME_LEVEL_COLUMNS,
  PLAY_PLAYER_NAME_COLUMNS,
  PLAY_TO_GAME_COLUMNS,
  PLAYER_COLUMNS,
  PLAYER_SOURCE_ID_COLUMNS,
  PLAYER_WEEK_STAT_COLUMNS,
  ROSTER_COLUMNS,
  ROSTER_DROPPED_COLUMNS,
  ROSTER_PLAYER_FILL_COLUMNS,
  ROSTER_SOURCE_ID_COLUMNS,
  SNAP_COUNT_COLUMNS,
  TEAM_COLUMNS,
  TEAM_WEEK_STAT_COLUMNS,
  without,
} from './dataset-columns.js';

/** Which seasons a dataset loads; see the header above. */
export type DatasetScope = 'history' | 'single_file';
/** When a seasonal dataset switches to the new season (D6). */
export type SeasonRollover = 'march_15' | 'season_opener';

/** Target column name, or a column plus a cast from the CSV string. */
export type ColumnSpec = string | { to: string; cast?: (value: string) => unknown };

/**
 * One SQL statement run inside a piece's publishing transaction. `{staging}` is replaced by the
 * quoted name of the piece's staging table, which a statement may reference only once (a MySQL
 * limit on TEMPORARY tables). With `report`, the affected-row count is logged when above zero.
 */
export interface SqlStep {
  sql: string;
  /** Label for the affected-row count in the run log. */
  report?: string;
}

/** A row is loaded only when this column's value exists in the parent table (roster exclusion, ADR-0024). */
export interface ParentRequirement {
  /** The CSV column holding the reference. */
  column: string;
  /** The parent table. */
  table: string;
  /** The parent table's key column. */
  parentColumn: string;
}

/**
 * How a dataset's provider-ID columns become rows of a mapping table (ADR-0023).
 * `authoritative`: this file's ID replaces a stored one (players.csv, games.csv, play-by-play).
 * `fill`: an ID is stored only where the owner has none for that provider; a differing value is
 * logged, not stored (the roster file).
 */
export interface SourceIdSpec {
  /** Mapping table. */
  table: 'player_source' | 'game_source';
  /** The mapping table's owner-key column (the player or game). */
  ownerColumn: string;
  /** The mapping table's provider-ID column. */
  idColumn: string;
  /** SQL type of the owner key, identical to the mapping table's column. */
  ownerType: string;
  /** Staging column holding the owner key. */
  stagingOwner: string;
  /** Whether this file's IDs replace stored ones or only fill gaps. */
  mode: 'authoritative' | 'fill';
  /** Staging column -> provider code in `source`. */
  columns: Readonly<Record<string, string>>;
  /**
   * A table whose rows point at the mapping by (provider code, provider ID): before a stored ID
   * changes, those rows are unlinked, since the foreign key would block the change (snap counts).
   */
  unlink?: { table: string; codeColumn: string; idColumn: string };
}

/**
 * Which rows of the table belong to one piece, for the quarterly reconciliation (ADR-0028).
 * `column`: rows whose season column equals the piece's season. `game`: the table has no season
 * column, so rows belong to the season of their game. `range`: rows between the file's smallest
 * and largest value of the column.
 */
export type PieceScope =
  | { kind: 'column'; column: string }
  | { kind: 'game' }
  | { kind: 'range'; column: string };

/** One nflverse dataset and its hand-written mapping. */
export interface DatasetDef {
  name: string;
  scope: DatasetScope;
  /** First season loaded, when later than HISTORY_START_SEASON (play-by-play, depth charts: ADR-0013). */
  startSeason?: number;
  /** When the dataset switches to a new season (D6). Default: season_opener. */
  rollover?: SeasonRollover;
  /** Path under env.releaseBase; `season` is ignored for single-file datasets. */
  path: (season: number) => string;
  /** True when the file is gzip-compressed. */
  gzip?: boolean;
  /** MySQL table to load into. Required for loading. */
  table?: string;
  /** CSV header -> the table's own column. Required for loading. */
  columns?: Record<string, ColumnSpec>;
  /** CSV columns staged for `before`/`after`/`sourceIds` but not stored on `table`: header -> SQL type. */
  stageOnly?: Readonly<Record<string, string>>;
  /** Table columns that keep their stored value when the file's value is empty (ADR-0026). */
  keepStored?: readonly string[];
  /** Table column -> SQL expression used on update in place of the staged value; `t` is the table, `s` staging. */
  updateExpressions?: Readonly<Record<string, string>>;
  /** Natural-key CSV columns; a row with any empty key column is dropped by the load (§7.2.3, §8). */
  naturalKey?: readonly string[];
  /** Mapped columns that may be absent from the file header (injuries' two headers, §7.2). */
  optionalColumns?: readonly string[];
  /** When a natural key repeats, keep the row with the greatest value of this column (injuries, §8). */
  dedupeBy?: string;
  /** Rows whose reference is missing from the parent table are excluded and counted (ADR-0024). */
  requireParent?: ParentRequirement;
  /** Statements run before the table's own upsert (lookup rows that the table references). */
  before?: readonly SqlStep[];
  /** Statements run after the table's own upsert. */
  after?: readonly SqlStep[];
  /** Provider-ID columns written as mapping rows after the upsert. */
  sourceIds?: SourceIdSpec;
  /** How the quarterly reconciliation finds this piece's rows; absent: rows are never deleted. */
  reconcile?: PieceScope;
}

/** SQL type of a staged provider ID: text, as `player_source` and `game_source` store it. */
const SOURCE_ID_TYPE = 'VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL';

/** Staging-only declarations for a set of provider-ID columns. */
const sourceIdStaging = (columns: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.keys(columns).map((column) => [column, SOURCE_ID_TYPE]));

/**
 * Every dataset, in load order. `columns` is identity (CSV header -> identically named MySQL column,
 * §7.2.2) built by `columnsFor`, with `toUtcDateTime` casts on the ISO timestamp columns. The two
 * fantasy-point columns are excluded from `player_week_stat` by being absent from its column list (ADR-0007).
 */
export const datasets: DatasetDef[] = [
  // Loaded first: every team-code column has a foreign key to it (D9a; ETL spec §7.2).
  { name: 'teams', scope: 'single_file', path: () => 'teams/teams_colors_logos.csv',
    table: 'team', columns: columnsFor(TEAM_COLUMNS), naturalKey: ['team_abbr'] },

  // Players before everything that names a player (ADR-0022). The seven provider-ID columns become
  // player_source rows (ADR-0023). Columns the roster load can fill keep a stored value when
  // players.csv has none (ADR-0026).
  { name: 'players', scope: 'single_file', path: () => 'players/players.csv',
    table: 'player',
    columns: columnsFor(without(PLAYER_COLUMNS, Object.keys(PLAYER_SOURCE_ID_COLUMNS))),
    stageOnly: sourceIdStaging(PLAYER_SOURCE_ID_COLUMNS),
    keepStored: ['short_name', 'first_name', 'last_name', 'football_name', 'birth_date', 'college_name'],
    naturalKey: ['gsis_id'],
    sourceIds: {
      table: 'player_source', ownerColumn: 'gsis_id', idColumn: 'source_player_id',
      ownerType: 'VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin', stagingOwner: 'gsis_id',
      mode: 'authoritative', columns: PLAYER_SOURCE_ID_COLUMNS,
      unlink: { table: 'snap_count', codeColumn: 'source_code', idColumn: 'pfr_player_id' },
    } },

  // Games before the tables that reference them. Stadiums are upserted first (ADR-0025): each
  // stadium takes the name it carries in its most recent season. A game whose facts came from
  // play-by-play (start_time set) keeps that play-by-play stadium name (ADR-0026).
  { name: 'schedules', scope: 'single_file', path: () => 'schedules/games.csv',
    table: 'game',
    columns: columnsFor(without(GAME_COLUMNS, Object.keys(GAME_SOURCE_ID_COLUMNS), ['away_qb_name', 'home_qb_name'])),
    stageOnly: sourceIdStaging(GAME_SOURCE_ID_COLUMNS),
    updateExpressions: { stadium: 'IF(t.`start_time` IS NOT NULL AND t.`stadium` IS NOT NULL, t.`stadium`, s.`stadium`)' },
    naturalKey: ['game_id'],
    before: [{
      sql: `INSERT INTO stadium (stadium_id, stadium_name)
            SELECT stadium_id, stadium FROM (
              SELECT stadium_id, stadium,
                     ROW_NUMBER() OVER (PARTITION BY stadium_id ORDER BY season DESC, COUNT(*) DESC, stadium) AS name_rank
                FROM {staging} WHERE stadium_id IS NOT NULL AND stadium IS NOT NULL
               GROUP BY stadium_id, season, stadium) AS ranked
             WHERE name_rank = 1
            ON DUPLICATE KEY UPDATE stadium_name = ranked.stadium`,
    }],
    sourceIds: {
      table: 'game_source', ownerColumn: 'game_id', idColumn: 'source_game_id',
      ownerType: 'VARCHAR(32) CHARACTER SET ascii', stagingOwner: 'game_id',
      mode: 'authoritative', columns: GAME_SOURCE_ID_COLUMNS,
    } },

  // Season rosters: the new season is published from March 15 (D6). A row whose player is not in
  // `player` is excluded (ADR-0024). The provider IDs fill player_source where the player has none,
  // and the player's own descriptions fill empty `player` columns (ADR-0023, ADR-0026).
  { name: 'rosters', scope: 'history', rollover: 'march_15', path: (season) => `rosters/roster_${season}.csv`,
    table: 'roster',
    columns: columnsFor(without(ROSTER_COLUMNS, Object.keys(ROSTER_SOURCE_ID_COLUMNS), ROSTER_PLAYER_FILL_COLUMNS, ROSTER_DROPPED_COLUMNS)),
    stageOnly: {
      ...sourceIdStaging(ROSTER_SOURCE_ID_COLUMNS),
      first_name: 'VARCHAR(32) NULL', last_name: 'VARCHAR(32) NULL', football_name: 'VARCHAR(32) NULL',
      birth_date: 'VARCHAR(16) NULL', college: 'VARCHAR(128) NULL',
    },
    naturalKey: ['season', 'team', 'gsis_id'],
    requireParent: { column: 'gsis_id', table: 'player', parentColumn: 'gsis_id' },
    after: [{
      report: 'player rows given a value only the roster holds',
      sql: `UPDATE player AS p
              JOIN (SELECT gsis_id, MAX(first_name) AS first_name, MAX(last_name) AS last_name,
                           MAX(football_name) AS football_name, MAX(birth_date) AS birth_date, MAX(college) AS college
                      FROM {staging} GROUP BY gsis_id) AS r ON r.gsis_id = p.gsis_id
               SET p.first_name = COALESCE(p.first_name, r.first_name),
                   p.last_name = COALESCE(p.last_name, r.last_name),
                   p.football_name = COALESCE(p.football_name, r.football_name),
                   p.birth_date = COALESCE(p.birth_date, r.birth_date),
                   p.college_name = COALESCE(p.college_name, r.college)
             WHERE (p.first_name IS NULL AND r.first_name IS NOT NULL)
                OR (p.last_name IS NULL AND r.last_name IS NOT NULL)
                OR (p.football_name IS NULL AND r.football_name IS NOT NULL)
                OR (p.birth_date IS NULL AND r.birth_date IS NOT NULL)
                OR (p.college_name IS NULL AND r.college IS NOT NULL)`,
    }],
    sourceIds: {
      table: 'player_source', ownerColumn: 'gsis_id', idColumn: 'source_player_id',
      ownerType: 'VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin', stagingOwner: 'gsis_id',
      mode: 'fill', columns: ROSTER_SOURCE_ID_COLUMNS,
    },
    reconcile: { kind: 'column', column: 'season' } },

  // Weekly player and team stat lines (nflfastR::calculate_stats). Every season from 2022. The
  // player's name and headshot live on `player`; the week's position stays (ADR-0026).
  { name: 'stats_player_week', scope: 'history', path: (season) => `stats_player/stats_player_week_${season}.csv`,
    table: 'player_week_stat',
    columns: columnsFor(without(PLAYER_WEEK_STAT_COLUMNS, ['player_name', 'player_display_name', 'headshot_url'])),
    naturalKey: ['season', 'season_type', 'week', 'player_id'],
    reconcile: { kind: 'column', column: 'season' } },
  { name: 'stats_team_week', scope: 'history', path: (season) => `stats_team/stats_team_week_${season}.csv`,
    table: 'team_week_stat', columns: columnsFor(TEAM_WEEK_STAT_COLUMNS),
    naturalKey: ['season', 'season_type', 'week', 'team'],
    reconcile: { kind: 'column', column: 'season' } },

  // Official injury reports. Two headers (2022-2024 date_modified, 2025+ season_type), both mapped;
  // date_modified is cast to MySQL DATETIME (§7.2). A repeated injury key keeps the latest
  // date_modified, or the last row in file order for 2025+ (§8).
  { name: 'injuries', scope: 'history', path: (season) => `injuries/injuries_${season}.csv`,
    table: 'injury_report',
    columns: columnsFor(without(INJURY_REPORT_COLUMNS, ['full_name', 'first_name', 'last_name']), { date_modified: toUtcDateTime }),
    naturalKey: ['season', 'week', 'game_type', 'team', 'gsis_id'],
    optionalColumns: ['date_modified', 'season_type'], dedupeBy: 'date_modified',
    reconcile: { kind: 'column', column: 'season' } },

  // Snap counts keep the Pro Football Reference ID as their player reference; `source_code` is set
  // by the re-link step when player_source knows the ID (ADR-0023, ADR-0024). The columns that
  // repeat `game` are not stored (ADR-0026).
  { name: 'snap_counts', scope: 'history', path: (season) => `snap_counts/snap_counts_${season}.csv`,
    table: 'snap_count',
    columns: columnsFor(without(SNAP_COUNT_COLUMNS, ['pfr_game_id', 'season', 'week', 'game_type'])),
    naturalKey: ['game_id', 'pfr_player_id'],
    reconcile: { kind: 'game' } },

  // Recorded from the 2026 season on; every season is kept (ADR-0013). ISO timestamps cast to
  // DATETIME. Depth charts: the formation and position names are upserted into their lookup tables
  // first (ADR-0025); a row with no GSIS ID keeps one already filled from its ESPN ID (ADR-0024).
  { name: 'depth_charts', scope: 'history', startSeason: 2026, path: (season) => `depth_charts/depth_charts_${season}.csv`,
    table: 'depth_chart',
    columns: columnsFor(without(DEPTH_CHART_COLUMNS, DEPTH_CHART_LOOKUP_COLUMNS), { dt: toUtcDateTime }),
    stageOnly: { pos_grp: 'VARCHAR(32) NULL', pos_name: 'VARCHAR(32) NULL', pos_abb: 'VARCHAR(8) NULL' },
    keepStored: ['gsis_id'],
    naturalKey: ['dt', 'team', 'pos_grp_id', 'pos_slot', 'pos_rank'],
    before: [
      { sql: `INSERT INTO position_group (pos_grp_id, pos_grp)
              SELECT pos_grp_id, name FROM (
                SELECT pos_grp_id, MAX(pos_grp) AS name FROM {staging} WHERE pos_grp IS NOT NULL GROUP BY pos_grp_id) AS found
              ON DUPLICATE KEY UPDATE pos_grp = found.name` },
      // `position` is also a MySQL function name, so the table name is always quoted.
      { sql: `INSERT INTO \`position\` (pos_id, pos_name, pos_abb)
              SELECT pos_id, name, abbreviation FROM (
                SELECT pos_id, MAX(pos_name) AS name, MAX(pos_abb) AS abbreviation FROM {staging}
                 WHERE pos_id IS NOT NULL AND pos_name IS NOT NULL AND pos_abb IS NOT NULL GROUP BY pos_id) AS found
              ON DUPLICATE KEY UPDATE pos_name = found.name, pos_abb = found.abbreviation` },
    ],
    reconcile: { kind: 'range', column: 'dt' } },

  // Play-by-play uses the gzip file. Game-level columns and player names are not stored on `play`
  // (ADR-0026); four game facts go to `game`, and the NFL API game ID to game_source (ADR-0023).
  { name: 'pbp', scope: 'history', startSeason: 2026, path: (season) => `pbp/play_by_play_${season}.csv.gz`, gzip: true,
    table: 'play',
    columns: columnsFor(
      without(PLAY_COLUMNS, PLAY_GAME_LEVEL_COLUMNS, PLAY_PLAYER_NAME_COLUMNS, PLAY_TO_GAME_COLUMNS),
      { time_of_day: toUtcDateTime, end_clock_time: toUtcDateTime, drive_real_start_time: toUtcDateTime },
    ),
    stageOnly: {
      start_time: 'VARCHAR(32) NULL', weather: 'VARCHAR(128) NULL', home_opening_kickoff: 'TINYINT NULL',
      stadium: 'VARCHAR(64) NULL', nfl_api_id: SOURCE_ID_TYPE,
    },
    naturalKey: ['game_id', 'play_id'],
    after: [{
      report: 'game rows given start time, weather, opening kickoff and stadium name from play-by-play',
      sql: `UPDATE game AS g
              JOIN (SELECT game_id, MAX(start_time) AS start_time, MAX(weather) AS weather,
                           MAX(home_opening_kickoff) AS home_opening_kickoff, MAX(stadium) AS stadium
                      FROM {staging} GROUP BY game_id) AS p ON p.game_id = g.game_id
               SET g.start_time = COALESCE(p.start_time, g.start_time),
                   g.weather = COALESCE(p.weather, g.weather),
                   g.home_opening_kickoff = COALESCE(p.home_opening_kickoff, g.home_opening_kickoff),
                   g.stadium = COALESCE(p.stadium, g.stadium)`,
    }],
    sourceIds: {
      table: 'game_source', ownerColumn: 'game_id', idColumn: 'source_game_id',
      ownerType: 'VARCHAR(32) CHARACTER SET ascii', stagingOwner: 'game_id',
      mode: 'authoritative', columns: { nfl_api_id: 'nfl_api' },
    },
    reconcile: { kind: 'game' } },
];

/**
 * Statements that link rows loaded without a player once the matching provider ID is known
 * (ADR-0024). Run after every piece and once more at the end of a run.
 */
export const RELINK_STEPS: readonly SqlStep[] = [
  { report: 'snap-count rows linked to a player by PFR ID',
    sql: `UPDATE snap_count AS sc
            JOIN player_source AS ps ON ps.source_code = 'pfr' AND ps.source_player_id = sc.pfr_player_id
             SET sc.source_code = 'pfr'
           WHERE sc.source_code IS NULL` },
  { report: 'depth-chart rows given a GSIS ID from their ESPN ID',
    sql: `UPDATE depth_chart AS d
            JOIN player_source AS ps ON ps.source_code = 'espn'
                 AND ps.source_player_id = CONVERT(CAST(d.espn_id AS CHAR) USING ascii) COLLATE ascii_bin
             SET d.gsis_id = ps.gsis_id
           WHERE d.gsis_id IS NULL AND d.espn_id IS NOT NULL` },
];

/** Counts of rows still loaded without a player, reported at the end of every run (ADR-0024). */
export const UNLINKED_COUNTS: readonly { label: string; sql: string }[] = [
  { label: 'snap-count rows with an unknown PFR ID', sql: 'SELECT COUNT(*) AS n FROM snap_count WHERE source_code IS NULL' },
  { label: 'depth-chart rows with no GSIS ID', sql: 'SELECT COUNT(*) AS n FROM depth_chart WHERE gsis_id IS NULL' },
];

/** The dataset with this name, if any. */
export function findDataset(name: string): DatasetDef | undefined {
  return datasets.find((dataset) => dataset.name === name);
}
