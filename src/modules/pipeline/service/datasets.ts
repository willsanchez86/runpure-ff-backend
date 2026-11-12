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

/** Which seasons a dataset loads and keeps; see the header above. */
export type DatasetScope = 'history' | 'current_season' | 'single_file';
/** When a seasonal dataset switches to the new season (D6). */
export type SeasonRollover = 'march_15' | 'season_opener';

/** Target column name, or a column plus a cast from the CSV string. */
export type ColumnSpec = string | { to: string; cast?: (value: string) => unknown };

/** One nflverse dataset and its hand-written mapping. */
export interface DatasetDef {
  name: string;
  scope: DatasetScope;
  /** When the dataset switches to a new season (D6). Default: season_opener. */
  rollover?: SeasonRollover;
  /** Path under RELEASE_BASE; `season` is ignored for single-file datasets. */
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
}

/** Base URL of nflverse release files. */
export const RELEASE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

/** Every dataset, in load order. */
export const datasets: DatasetDef[] = [
  // Loaded first: every team-code column has a foreign key to it (D9a; ETL spec §7.2).
  { name: 'teams', scope: 'single_file', replace: 'upsert', path: () => 'teams/teams_colors_logos.csv' },

  // Weekly player and team stat lines (nflfastR::calculate_stats). Every season from 2022.
  { name: 'stats_player_week', scope: 'history', path: (s) => `stats_player/stats_player_week_${s}.csv` },
  { name: 'stats_team_week', scope: 'history', path: (s) => `stats_team/stats_team_week_${s}.csv` },

  // Season rosters: the new season is published from March 15 (D6).
  { name: 'rosters', scope: 'history', rollover: 'march_15', path: (s) => `rosters/roster_${s}.csv` },

  // Snap counts and official injury reports.
  { name: 'snap_counts', scope: 'history', path: (s) => `snap_counts/snap_counts_${s}.csv` },
  { name: 'injuries', scope: 'history', path: (s) => `injuries/injuries_${s}.csv` },

  // Single files covering all seasons. Player and game references carry no database
  // foreign key (ETL spec §7.2), so these two are replaced whole.
  { name: 'schedules', scope: 'single_file', path: () => 'schedules/games.csv' },
  { name: 'players', scope: 'single_file', path: () => 'players/players.csv' },

  // Current season only (ADR-0013). Play-by-play uses the gzip file.
  { name: 'depth_charts', scope: 'current_season', path: (s) => `depth_charts/depth_charts_${s}.csv` },
  { name: 'pbp', scope: 'current_season', path: (s) => `pbp/play_by_play_${s}.csv.gz`, gzip: true },

  // Shape of a mapped dataset (illustration only; columns keep nflverse's names, §7.2.2):
  // {
  //   name: 'schedules', scope: 'single_file', path: () => 'schedules/games.csv',
  //   table: 'game',
  //   columns: {
  //     game_id: 'game_id',
  //     season: { to: 'season', cast: Number },
  //     week: { to: 'week', cast: Number },
  //     gameday: 'gameday',
  //     home_team: 'home_team',
  //     away_team: 'away_team',
  //   },
  // },
];

/** The dataset with this name, if any. */
export function findDataset(name: string): DatasetDef | undefined {
  return datasets.find((d) => d.name === name);
}
