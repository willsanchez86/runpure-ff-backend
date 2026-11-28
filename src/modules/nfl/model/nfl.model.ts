/** Hand-written reads for the player/team/game/stat contract (ADR-0010;
 * docs/api-contract/02-field-mapping.md). Every value is parameter-bound. */
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** Position groups the contract serves (K lives under SPEC + position='K').
 * Individual defensive players were removed from Phase 1 (owner, 2026-11-17). */
const SKILL_GROUPS = ['QB', 'RB', 'WR', 'TE'];

/** One player row as the contract needs it (age computed in SQL). */
export interface PlayerRow extends RowDataPacket {
  gsis_id: string;
  display_name: string | null;
  position_group: string | null;
  position: string | null;
  latest_team: string | null;
  jersey_number: number | null;
  age: number | null;
  height: number | null;
  weight: number | null;
  college_name: string | null;
  rookie_season: number | null;
  years_of_experience: number | null;
  draft_year: number | null;
  draft_round: number | null;
  draft_pick: number | null;
  status: string | null;
}

/** Fantasy-relevant players for a season: has a stat row, or active roster. */
export async function findSeasonPlayers(pool: Pool, season: number): Promise<PlayerRow[]> {
  const [rows] = await pool.query<PlayerRow[]>(
    `SELECT p.gsis_id, p.display_name, p.position_group, p.position, p.latest_team,
            p.jersey_number, TIMESTAMPDIFF(YEAR, p.birth_date, CURDATE()) AS age,
            p.height, p.weight, p.college_name, p.rookie_season, p.years_of_experience,
            p.draft_year, p.draft_round, p.draft_pick, p.status
       FROM player p
      WHERE (p.position_group IN (?) OR (p.position_group = 'SPEC' AND p.position = 'K'))
        AND (EXISTS (SELECT 1 FROM player_week_stat s
                      WHERE s.player_id = p.gsis_id AND s.season = ?)
             -- active roster, but only players whose career reaches this season
             OR (p.status = 'ACT' AND (p.last_season IS NULL OR p.last_season >= ?)))`,
    [SKILL_GROUPS, season, season],
  );
  return rows;
}

/** The latest injury report per player for a season. */
export interface InjuryRow extends RowDataPacket {
  gsis_id: string;
  report_status: string | null;
  practice_status: string | null;
}

/** Latest-week injury report rows for a season, one per player. */
export async function findLatestInjuries(pool: Pool, season: number): Promise<InjuryRow[]> {
  const [rows] = await pool.query<InjuryRow[]>(
    `SELECT i.gsis_id, i.report_status, i.practice_status
       FROM injury_report i
       JOIN (SELECT gsis_id, MAX(week) AS max_week
               FROM injury_report WHERE season = ? GROUP BY gsis_id) latest
         ON latest.gsis_id = i.gsis_id AND latest.max_week = i.week
      WHERE i.season = ?`,
    [season, season],
  );
  return rows;
}

/** One team reference row. */
export interface TeamRow extends RowDataPacket {
  team_abbr: string;
  team_name: string | null;
  team_nick: string | null;
  team_conf: string | null;
  team_division: string | null;
  team_color: string | null;
  team_logo_squared: string | null;
  team_logo_espn: string | null;
  team_logo_wikipedia: string | null;
}

/** All 32 team reference rows. */
export async function findTeams(pool: Pool): Promise<TeamRow[]> {
  const [rows] = await pool.query<TeamRow[]>(
    `SELECT team_abbr, team_name, team_nick, team_conf, team_division,
            team_color, team_logo_squared, team_logo_espn, team_logo_wikipedia
       FROM team`,
  );
  return rows;
}

/** One game row with everything the contract's Game carries. */
export interface GameRow extends RowDataPacket {
  game_id: string;
  season: number | null;
  game_type: string | null;
  week: number | null;
  gameday: string | null;
  gametime: string | null;
  away_team: string | null;
  home_team: string | null;
  away_score: number | null;
  home_score: number | null;
  overtime: number | null;
  stadium: string | null;
  roof: string | null;
  surface: string | null;
  temp: number | null;
  wind: number | null;
  spread_line: number | null;
  total_line: number | null;
  away_qb_name: string | null;
  home_qb_name: string | null;
  away_coach: string | null;
  home_coach: string | null;
  away_rest: number | null;
  home_rest: number | null;
  div_game: number | null;
}

/** Every game of a season (all phases the source carries). */
export async function findSeasonGames(pool: Pool, season: number): Promise<GameRow[]> {
  const [rows] = await pool.query<GameRow[]>(
    `SELECT game_id, season, game_type, week, DATE_FORMAT(gameday, '%Y-%m-%d') AS gameday,
            gametime, away_team, home_team, away_score, home_score, overtime,
            stadium, roof, surface, temp, wind, spread_line, total_line,
            away_qb.display_name AS away_qb_name, home_qb.display_name AS home_qb_name,
            away_coach, home_coach, away_rest, home_rest, div_game
       FROM game
       -- quarterback names live on player (ADR-0026); the IDs carry foreign keys (ADR-0022)
       LEFT JOIN player AS away_qb ON away_qb.gsis_id = game.away_qb_id
       LEFT JOIN player AS home_qb ON home_qb.gsis_id = game.home_qb_id
      WHERE game.season = ?`,
    [season],
  );
  return rows;
}

/** One player week-stat row joined with snap share and home/away. */
export interface StatRow extends RowDataPacket {
  player_id: string;
  week: number;
  team: string | null;
  opponent_team: string | null;
  position_group: string | null;
  position: string | null;
  home_team: string | null;
  offense_pct: number | null;
  defense_pct: number | null;
  completions: number | null;
  attempts: number | null;
  passing_yards: number | null;
  passing_tds: number | null;
  passing_interceptions: number | null;
  sacks_suffered: number | null;
  sack_yards_lost: number | null;
  passing_first_downs: number | null;
  carries: number | null;
  rushing_yards: number | null;
  rushing_tds: number | null;
  rushing_first_downs: number | null;
  targets: number | null;
  receptions: number | null;
  receiving_yards: number | null;
  receiving_tds: number | null;
  receiving_first_downs: number | null;
  fumbles_total: number | null;
  fumbles_lost_total: number | null;
  target_share: number | null;
  air_yards_share: number | null;
  wopr: number | null;
  fg_made: number | null;
  fg_missed: number | null;
  fg_blocked: number | null;
  fg_made_50_59: number | null;
  fg_made_60_: number | null;
  pat_made: number | null;
  def_tackles_solo: number | null;
  def_tackle_assists: number | null;
  def_sacks: number | null;
  def_tackles_for_loss: number | null;
  def_interceptions: number | null;
  def_pass_defended: number | null;
  def_fumbles_forced: number | null;
  fumble_recovery_opp: number | null;
  def_qb_hits: number | null;
  def_tds: number | null;
}

/** One keyset page of regular-season stat rows, ordered (player_id, week). */
export async function findStatPage(
  pool: Pool,
  season: number,
  afterPlayerId: string,
  afterWeek: number,
  limit: number,
): Promise<StatRow[]> {
  const [rows] = await pool.query<StatRow[]>(
    `SELECT s.player_id, s.week, s.team, s.opponent_team,
            p.position_group, p.position, g.home_team,
            sc.offense_pct, sc.defense_pct,
            s.completions, s.attempts, s.passing_yards, s.passing_tds,
            s.passing_interceptions, s.sacks_suffered, s.sack_yards_lost,
            s.passing_first_downs, s.carries, s.rushing_yards, s.rushing_tds,
            s.rushing_first_downs, s.targets, s.receptions, s.receiving_yards,
            s.receiving_tds, s.receiving_first_downs, s.fumbles_total,
            s.fumbles_lost_total, s.target_share, s.air_yards_share, s.wopr,
            s.fg_made, s.fg_missed, s.fg_blocked, s.fg_made_50_59, s.fg_made_60_,
            s.pat_made, s.def_tackles_solo, s.def_tackle_assists, s.def_sacks,
            s.def_tackles_for_loss, s.def_interceptions, s.def_pass_defended,
            s.def_fumbles_forced, s.fumble_recovery_opp, s.def_qb_hits, s.def_tds
       FROM player_week_stat s
       JOIN player p ON p.gsis_id = s.player_id
       LEFT JOIN game g ON g.game_id = s.game_id
       -- snap counts name players by PFR ID; player_source maps it to the GSIS ID (ADR-0023)
       LEFT JOIN player_source pfr ON pfr.gsis_id = s.player_id AND pfr.source_code = 'pfr'
       LEFT JOIN snap_count sc
         ON sc.game_id = s.game_id AND sc.source_code = pfr.source_code
        AND sc.pfr_player_id = pfr.source_player_id
      WHERE s.season = ? AND s.season_type = 'REG'
        -- IDP removed from Phase 1 (owner, 2026-11-17): offensive groups + K only
        AND (p.position_group IN (?) OR (p.position_group = 'SPEC' AND p.position = 'K'))
        AND (s.player_id > ? OR (s.player_id = ? AND s.week > ?))
      ORDER BY s.player_id, s.week
      LIMIT ?`,
    [season, SKILL_GROUPS, afterPlayerId, afterPlayerId, afterWeek, limit],
  );
  return rows;
}

/** One team-defense week: own defensive stats + opponent yards + game score. */
export interface DefWeekRow extends RowDataPacket {
  team: string;
  week: number;
  opponent_team: string | null;
  home_team: string | null;
  home_score: number | null;
  away_score: number | null;
  yards_allowed: number | null;
  def_sacks: number | null;
  def_interceptions: number | null;
  fumble_recovery_opp: number | null;
  def_tds: number | null;
  special_teams_tds: number | null;
  def_safeties: number | null;
}

/** Team-defense weeks for a season (DefStatLine assembly; mapping doc). */
export async function findDefWeeks(pool: Pool, season: number): Promise<DefWeekRow[]> {
  const [rows] = await pool.query<DefWeekRow[]>(
    `SELECT t.team, t.week, t.opponent_team, g.home_team, g.home_score, g.away_score,
            (COALESCE(opp.passing_yards, 0) + COALESCE(opp.rushing_yards, 0)) AS yards_allowed,
            t.def_sacks, t.def_interceptions, t.fumble_recovery_opp,
            t.def_tds, t.special_teams_tds, t.def_safeties
       FROM team_week_stat t
       LEFT JOIN team_week_stat opp
         ON opp.season = t.season AND opp.week = t.week
        AND opp.season_type = t.season_type AND opp.team = t.opponent_team
       LEFT JOIN game g ON g.game_id = t.game_id
      WHERE t.season = ? AND t.season_type = 'REG'`,
    [season],
  );
  return rows;
}

/** Per-dataset last successful load time (dataFreshness; ingest_ledger). */
export interface FreshnessRow extends RowDataPacket {
  dataset: string;
  loaded_at: Date | null;
}

/** MAX(finished_at) of loaded pieces, per dataset. */
export async function findFreshness(pool: Pool): Promise<FreshnessRow[]> {
  const [rows] = await pool.query<FreshnessRow[]>(
    `SELECT dataset, MAX(finished_at) AS loaded_at
       FROM ingest_ledger WHERE status = 'loaded' GROUP BY dataset`,
  );
  return rows;
}
