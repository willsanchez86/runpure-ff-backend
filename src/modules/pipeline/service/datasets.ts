/**
 * nflverse dataset registry: the Phase 1 datasets (ETL spec D2) plus the team file (D9a).
 * Weekly rosters are not loaded (D2).
 *
 * Each entry names one published release file per season (or one file in total).
 * `scope` decides which seasons are loaded and kept:
 *   history        - 2022..current, backfilled once (ADR-0006)
 *   current_season - current season only; the previous season is removed (ADR-0013)
 *   single_file    - one file covering all seasons, replaced whole
 * `rollover` decides when a seasonal dataset moves to the new season (D6):
 *   march_15       - season rosters
 *   season_opener  - everything else: the Wednesday after Labor Day (default)
 *
 * Order matters: datasets load in this order, and `team` comes first because every
 * team-code column has a foreign key to it (ETL spec §7.2). `team` loads by upsert,
 * since MySQL rejects deleting a team row that other tables still reference.
 *
 * `table` and `columns` are the hand-written mapping (ADR-0010) from CSV header to
 * MySQL column. A dataset without them is skipped by the loader. Run
 * `npm run headers -- --dataset <name>` to list a dataset's columns; table and column
 * names follow the ETL spec §7.2 and its data dictionary.
 *
 * File paths from the ETL spec §4.1.
 */

import { toUtcDateTime } from './casts.js';
import { columnsFor } from './columns.js';
import {
  DEPTH_CHART_COLUMNS,
  GAME_COLUMNS,
  INJURY_REPORT_COLUMNS,
  PLAY_COLUMNS,
  PLAYER_COLUMNS,
  PLAYER_WEEK_STAT_COLUMNS,
  ROSTER_COLUMNS,
  SNAP_COUNT_COLUMNS,
  TEAM_COLUMNS,
  TEAM_WEEK_STAT_COLUMNS,
} from './dataset-columns.js';

/** Which seasons a dataset loads and keeps; see the header above. */
export type DatasetScope = 'history' | 'current_season' | 'single_file';
/** When a seasonal dataset switches to the new season (D6). */
export type SeasonRollover = 'march_15' | 'season_opener';

/** Target column name, or a column plus a cast from the CSV string. */
export type ColumnSpec = string | { to: string; cast?: (value: string) => unknown };

/** A fact-table column referencing a parent table that carries no database foreign key (ETL spec §7.2). */
export interface DatasetReference {
  /** The fact-table (CSV) column holding the reference. */
  column: string;
  /** The parent table. */
  table: string;
  /** The parent-table column the reference points to. */
  parentColumn: string;
}

/** One nflverse dataset and its hand-written mapping. */
export interface DatasetDef {
  name: string;
  scope: DatasetScope;
  /** When the dataset switches to a new season (D6). Default: season_opener. */
  rollover?: SeasonRollover;
  /** Path under env.releaseBase; `season` is ignored for single-file datasets. */
  path: (season: number) => string;
  /** True when the file is gzip-compressed. */
  gzip?: boolean;
  /** 'upsert': insert new rows and update existing ones, delete none (the team table). */
  replace?: 'upsert';
  /** MySQL table to load into. Required for loading. */
  table?: string;
  /** CSV column holding the season (history datasets only). Default "season". */
  seasonColumn?: string;
  /** CSV header -> MySQL column. Required for loading. */
  columns?: Record<string, ColumnSpec>;
  /** Natural-key CSV columns; a row with any empty key column is dropped by the load (§7.2.3, §8). */
  naturalKey?: readonly string[];
  /** Mapped columns that may be absent from the file header (injuries' two headers, §7.2). */
  optionalColumns?: readonly string[];
  /** When a natural key repeats, keep the row with the greatest value of this column (injuries, §8). */
  dedupeBy?: string;
  /** Player/game references with no database foreign key; the load warns on misses (§7.2, §8). */
  references?: readonly DatasetReference[];
}

/**
 * Every dataset, in load order. `columns` is identity (CSV header -> identically named MySQL column,
 * §7.2.2) built by `columnsFor`, with `toUtcDateTime` casts on the ISO timestamp columns. The two
 * fantasy-point columns are excluded from `player_week_stat` by being absent from its column list (ADR-0007).
 */
export const datasets: DatasetDef[] = [
  // Loaded first: every team-code column has a foreign key to it (D9a; ETL spec §7.2).
  { name: 'teams', scope: 'single_file', replace: 'upsert', path: () => 'teams/teams_colors_logos.csv',
    table: 'team', columns: columnsFor(TEAM_COLUMNS), naturalKey: ['team_abbr'] },

  // Weekly player and team stat lines (nflfastR::calculate_stats). Every season from 2022.
  { name: 'stats_player_week', scope: 'history', path: (s) => `stats_player/stats_player_week_${s}.csv`,
    table: 'player_week_stat', columns: columnsFor(PLAYER_WEEK_STAT_COLUMNS),
    naturalKey: ['season', 'season_type', 'week', 'player_id'],
    references: [
      { column: 'player_id', table: 'player', parentColumn: 'gsis_id' },
      { column: 'game_id', table: 'game', parentColumn: 'game_id' },
    ] },
  { name: 'stats_team_week', scope: 'history', path: (s) => `stats_team/stats_team_week_${s}.csv`,
    table: 'team_week_stat', columns: columnsFor(TEAM_WEEK_STAT_COLUMNS),
    naturalKey: ['season', 'season_type', 'week', 'team'],
    references: [{ column: 'game_id', table: 'game', parentColumn: 'game_id' }] },

  // Season rosters: the new season is published from March 15 (D6).
  { name: 'rosters', scope: 'history', rollover: 'march_15', path: (s) => `rosters/roster_${s}.csv`,
    table: 'roster', columns: columnsFor(ROSTER_COLUMNS),
    naturalKey: ['season', 'team', 'gsis_id'],
    references: [{ column: 'gsis_id', table: 'player', parentColumn: 'gsis_id' }] },

  // Snap counts and official injury reports. Injuries has two headers (2022-2024 date_modified,
  // 2025+ season_type), both mapped; date_modified is cast to MySQL DATETIME (§7.2). A repeated
  // injury key keeps the latest date_modified, or the last row in file order for 2025+ (§8).
  { name: 'snap_counts', scope: 'history', path: (s) => `snap_counts/snap_counts_${s}.csv`,
    table: 'snap_count', columns: columnsFor(SNAP_COUNT_COLUMNS),
    naturalKey: ['game_id', 'pfr_player_id'],
    references: [
      { column: 'game_id', table: 'game', parentColumn: 'game_id' },
      { column: 'pfr_player_id', table: 'player', parentColumn: 'pfr_id' },
    ] },
  { name: 'injuries', scope: 'history', path: (s) => `injuries/injuries_${s}.csv`,
    table: 'injury_report', columns: columnsFor(INJURY_REPORT_COLUMNS, { date_modified: toUtcDateTime }),
    naturalKey: ['season', 'week', 'game_type', 'team', 'gsis_id'],
    optionalColumns: ['date_modified', 'season_type'], dedupeBy: 'date_modified',
    references: [{ column: 'gsis_id', table: 'player', parentColumn: 'gsis_id' }] },

  // Single files covering all seasons. Player and game references carry no database
  // foreign key (ETL spec §7.2), so these two are replaced whole.
  { name: 'schedules', scope: 'single_file', path: () => 'schedules/games.csv',
    table: 'game', columns: columnsFor(GAME_COLUMNS), naturalKey: ['game_id'] },
  { name: 'players', scope: 'single_file', path: () => 'players/players.csv',
    table: 'player', columns: columnsFor(PLAYER_COLUMNS), naturalKey: ['gsis_id'] },

  // Current season only (ADR-0013). Play-by-play uses the gzip file. ISO timestamps cast to DATETIME.
  { name: 'depth_charts', scope: 'current_season', path: (s) => `depth_charts/depth_charts_${s}.csv`,
    table: 'depth_chart', columns: columnsFor(DEPTH_CHART_COLUMNS, { dt: toUtcDateTime }),
    naturalKey: ['dt', 'team', 'pos_grp_id', 'pos_slot', 'pos_rank'],
    references: [{ column: 'gsis_id', table: 'player', parentColumn: 'gsis_id' }] },
  { name: 'pbp', scope: 'current_season', path: (s) => `pbp/play_by_play_${s}.csv.gz`, gzip: true,
    table: 'play',
    columns: columnsFor(PLAY_COLUMNS, {
      time_of_day: toUtcDateTime,
      end_clock_time: toUtcDateTime,
      drive_real_start_time: toUtcDateTime,
    }),
    naturalKey: ['game_id', 'play_id'],
    references: [{ column: 'game_id', table: 'game', parentColumn: 'game_id' }] },
];

/** The dataset with this name, if any. */
export function findDataset(name: string): DatasetDef | undefined {
  return datasets.find((d) => d.name === name);
}
