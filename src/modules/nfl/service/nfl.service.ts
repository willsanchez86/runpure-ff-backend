/** Shapes the model rows into the contract (docs/api-contract/02-field-mapping.md).
 * Fantasy points and every derived number stay client-side (ADR-0007). */
import type { Pool } from 'mysql2/promise';
import {
  findDefWeeks,
  findFreshness,
  findLatestInjuries,
  findSeasonGames,
  findSeasonPlayers,
  findStatPage,
  findTeams,
  type DefWeekRow,
  type GameRow,
  type StatRow,
} from '../model/nfl.model.js';

/** Hard page cap for statLines (player spec PE4). */
export const STAT_PAGE_CAP = 5000;

/** Contract position families; DEF rows are synthesized per team. */
export type ContractPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | 'DB' | 'LB' | 'DL';

/** A contract Player (field mapping doc, Player section). */
export interface ContractPlayer {
  id: string;
  name: string;
  position: ContractPosition;
  team: string | null;
  jerseyNumber: number | null;
  age: number | null;
  heightIn: number | null;
  weightLb: number | null;
  college: string | null;
  rookieYear: number | null;
  yearsExp: number | null;
  draftYear: number | null;
  draftRound: number | null;
  draftPick: number | null;
  injuryStatus: string | null;
  practiceStatus: string | null;
}

/** A contract Team (reference + venue/coach/bye derived from games). */
export interface ContractTeam {
  abbr: string;
  city: string;
  nickname: string;
  name: string;
  conference: string;
  division: string;
  stadium: string | null;
  roof: string | null;
  surface: string | null;
  headCoach: string | null;
  byeWeek: number | null;
  /** Squared logo preferred (renders best in chips), then ESPN, then Wikipedia. */
  logoUrl: string | null;
  /** Primary team colour, hex. */
  color: string | null;
}

/** A contract Game. */
export interface ContractGame {
  id: string;
  season: number;
  phase: 'PRE' | 'REG' | 'POST';
  week: number;
  kickoff: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  overtime: boolean;
  final: boolean;
  stadium: string | null;
  roof: string | null;
  surface: string | null;
  temperatureF: number | null;
  windMph: number | null;
  spreadLine: number | null;
  totalLine: number | null;
  favorite: string | null;
  homeQb: string | null;
  awayQb: string | null;
  homeCoach: string | null;
  awayCoach: string | null;
  homeRestDays: number | null;
  awayRestDays: number | null;
  divisionGame: boolean;
}

/** A stat line shaped for GraphQL; `family` picks the concrete type. */
export interface ContractStatLine {
  family: 'QB' | 'RB' | 'WRTE' | 'K' | 'DEF' | 'IDP';
  playerId: string;
  week: number;
  teamPlayedFor: string;
  opponent: string | null;
  home: boolean;
  snapPct: number | null;
  position: ContractPosition;
  stats: Record<string, number | null>;
}

/** One statLines page. */
export interface StatLinePage {
  items: ContractStatLine[];
  nextCursor: string | null;
}

/** The dataFreshness payload. */
export interface ContractFreshness {
  playersLoadedAt: string | null;
  statsLoadedAt: string | null;
  gamesLoadedAt: string | null;
}

/* ------------------------------------------------------------- pure maps */

/** position_group (+ position) -> contract position; null = out of contract. */
export function mapPosition(group: string | null, position: string | null): ContractPosition | null {
  if (group === 'QB' || group === 'RB' || group === 'WR' || group === 'TE') return group;
  if (group === 'DB' || group === 'LB' || group === 'DL') return group;
  if (group === 'SPEC' && position === 'K') return 'K';
  return null;
}

/** Report status -> the UI's Q/O codes; roster RES -> IR (mapping doc). */
export function mapInjuryStatus(reportStatus: string | null, rosterStatus: string | null): string | null {
  if (rosterStatus === 'RES') return 'IR';
  if (reportStatus == null) return null;
  const normalized = reportStatus.toLowerCase();
  if (normalized.startsWith('quest')) return 'Q';
  if (normalized.startsWith('out') || normalized.startsWith('doubt')) return 'O';
  return null;
}

/** game_type -> phase (nflverse carries no preseason rows). */
export function mapPhase(gameType: string | null): 'REG' | 'POST' {
  return gameType === 'REG' ? 'REG' : 'POST';
}

/** gameday + Eastern kickoff time -> ISO instant (EST offset; minute precision). */
export function kickoffIso(gameday: string | null, gametime: string | null): string {
  if (!gameday) return new Date(0).toISOString();
  const time = gametime && /^\d{2}:\d{2}/.test(gametime) ? gametime.slice(0, 5) : '13:00';
  return new Date(`${gameday}T${time}:00-05:00`).toISOString();
}

/** Opaque keyset cursor: "<playerId>:<week>". */
export function encodeCursor(playerId: string, week: number): string {
  return `${playerId}:${String(week)}`;
}

/** Decodes a cursor; the zero cursor starts from the beginning. */
export function decodeCursor(after: string | null | undefined): { playerId: string; week: number } {
  if (!after) return { playerId: '', week: 0 };
  const splitAt = after.lastIndexOf(':');
  if (splitAt < 1) return { playerId: '', week: 0 };
  const week = Number(after.slice(splitAt + 1));
  return { playerId: after.slice(0, splitAt), week: Number.isFinite(week) ? week : 0 };
}

/** "Arizona Cardinals" - "Cardinals" -> "Arizona". */
function cityOf(teamName: string | null, nickname: string | null): string {
  if (!teamName) return '';
  if (nickname && teamName.endsWith(nickname)) {
    return teamName.slice(0, teamName.length - nickname.length).trim();
  }
  return teamName;
}

/* -------------------------------------------------------------- services */

/** Fantasy-relevant players for a season + the 32 synthesized DEF rows. */
export async function seasonPlayers(pool: Pool, season: number): Promise<ContractPlayer[]> {
  const [playerRows, injuryRows, teamRows] = await Promise.all([
    findSeasonPlayers(pool, season),
    findLatestInjuries(pool, season),
    findTeams(pool),
  ]);
  const injuryById = new Map(injuryRows.map((row) => [row.gsis_id, row]));

  const players: ContractPlayer[] = [];
  for (const row of playerRows) {
    const position = mapPosition(row.position_group, row.position);
    if (!position) continue;
    const injury = injuryById.get(row.gsis_id);
    players.push({
      id: row.gsis_id,
      name: row.display_name ?? row.gsis_id,
      position,
      team: row.latest_team,
      jerseyNumber: row.jersey_number,
      age: row.age,
      heightIn: row.height,
      weightLb: row.weight,
      college: row.college_name,
      rookieYear: row.rookie_season,
      yearsExp: row.years_of_experience,
      draftYear: row.draft_year,
      draftRound: row.draft_round,
      draftPick: row.draft_pick,
      injuryStatus: mapInjuryStatus(injury?.report_status ?? null, row.status),
      practiceStatus: injury?.practice_status ?? null,
    });
  }
  // team defenses render as list rows (prototype behavior; mapping doc)
  for (const team of teamRows) {
    players.push({
      id: `DEF-${team.team_abbr}`,
      name: team.team_name ?? team.team_abbr,
      position: 'DEF',
      team: team.team_abbr,
      jerseyNumber: null,
      age: null,
      heightIn: null,
      weightLb: null,
      college: null,
      rookieYear: null,
      yearsExp: null,
      draftYear: null,
      draftRound: null,
      draftPick: null,
      injuryStatus: null,
      practiceStatus: null,
    });
  }
  return players;
}

/** Teams with venue/coach from their latest home game and the derived bye. */
export async function seasonTeams(pool: Pool, season: number): Promise<ContractTeam[]> {
  const [teamRows, gameRows] = await Promise.all([findTeams(pool), findSeasonGames(pool, season)]);
  const regGames = gameRows.filter((game) => game.game_type === 'REG');

  const weeksPlayed = new Map<string, Set<number>>();
  const latestHome = new Map<string, GameRow>();
  const latestAny = new Map<string, GameRow>();
  for (const game of regGames) {
    for (const abbr of [game.home_team, game.away_team]) {
      if (!abbr || game.week == null) continue;
      const set = weeksPlayed.get(abbr) ?? new Set<number>();
      set.add(game.week);
      weeksPlayed.set(abbr, set);
      const prior = latestAny.get(abbr);
      if (!prior || (prior.week ?? 0) < game.week) latestAny.set(abbr, game);
    }
    if (game.home_team) {
      const prior = latestHome.get(game.home_team);
      if (!prior || (prior.week ?? 0) < (game.week ?? 0)) latestHome.set(game.home_team, game);
    }
  }
  const maxWeek = Math.max(0, ...regGames.map((game) => game.week ?? 0));

  return teamRows.map((team) => {
    const played = weeksPlayed.get(team.team_abbr) ?? new Set<number>();
    let byeWeek: number | null = null;
    for (let week = 1; week <= maxWeek; week++) {
      if (!played.has(week)) {
        byeWeek = week;
        break;
      }
    }
    const home = latestHome.get(team.team_abbr);
    const any = latestAny.get(team.team_abbr);
    const coach =
      any?.home_team === team.team_abbr ? (any.home_coach ?? null) : (any?.away_coach ?? null);
    return {
      abbr: team.team_abbr,
      city: cityOf(team.team_name, team.team_nick),
      nickname: team.team_nick ?? team.team_abbr,
      name: team.team_name ?? team.team_abbr,
      conference: team.team_conf ?? '',
      division: team.team_division ?? '',
      stadium: home?.stadium ?? null,
      roof: home?.roof ?? null,
      surface: home?.surface ?? null,
      headCoach: coach,
      byeWeek,
      logoUrl: team.team_logo_squared ?? team.team_logo_espn ?? team.team_logo_wikipedia,
      color: team.team_color,
    };
  });
}

/** Every game of a season, contract-shaped. */
export async function seasonGames(pool: Pool, season: number): Promise<ContractGame[]> {
  const rows = await findSeasonGames(pool, season);
  return rows
    .filter((row) => row.home_team && row.away_team && row.week != null)
    .map((row) => {
      const spread = row.spread_line;
      return {
        id: row.game_id,
        season: row.season ?? season,
        phase: mapPhase(row.game_type),
        week: row.week ?? 0,
        kickoff: kickoffIso(row.gameday, row.gametime),
        homeTeam: row.home_team ?? '',
        awayTeam: row.away_team ?? '',
        homeScore: row.home_score,
        awayScore: row.away_score,
        overtime: Number(row.overtime) === 1,
        final: row.home_score != null && row.away_score != null,
        stadium: row.stadium,
        roof: row.roof,
        surface: row.surface,
        temperatureF: row.temp,
        windMph: row.wind,
        spreadLine: spread == null ? null : Math.abs(spread),
        totalLine: row.total_line,
        // nflverse convention: a positive spread_line favours the home team
        favorite: spread == null || spread === 0 ? null : spread > 0 ? row.home_team : row.away_team,
        homeQb: row.home_qb_name,
        awayQb: row.away_qb_name,
        homeCoach: row.home_coach,
        awayCoach: row.away_coach,
        homeRestDays: row.home_rest,
        awayRestDays: row.away_rest,
        divisionGame: Number(row.div_game) === 1,
      };
    });
}

function playerLine(row: StatRow): ContractStatLine | null {
  const position = mapPosition(row.position_group, row.position);
  if (!position || position === 'DEF') return null;
  const base = {
    playerId: row.player_id,
    week: row.week,
    teamPlayedFor: row.team ?? '',
    opponent: row.opponent_team,
    home: row.home_team != null && row.home_team === row.team,
    position,
  };
  const pct = (value: number | null) => (value == null ? null : Math.round(value * 1000) / 10);
  if (position === 'QB') {
    return {
      ...base,
      family: 'QB',
      snapPct: pct(row.offense_pct),
      stats: {
        attempts: row.attempts,
        completions: row.completions,
        passYards: row.passing_yards,
        passTds: row.passing_tds,
        interceptions: row.passing_interceptions,
        sacksTaken: row.sacks_suffered,
        sackYards: row.sack_yards_lost,
        carries: row.carries,
        rushYards: row.rushing_yards,
        rushTds: row.rushing_tds,
        fumbles: row.fumbles_total,
        fumblesLost: row.fumbles_lost_total,
        firstDowns: (row.passing_first_downs ?? 0) + (row.rushing_first_downs ?? 0),
      },
    };
  }
  if (position === 'RB' || position === 'WR' || position === 'TE') {
    return {
      ...base,
      family: position === 'RB' ? 'RB' : 'WRTE',
      snapPct: pct(row.offense_pct),
      stats: {
        carries: row.carries,
        rushYards: row.rushing_yards,
        rushTds: row.rushing_tds,
        targets: row.targets,
        receptions: row.receptions,
        recYards: row.receiving_yards,
        recTds: row.receiving_tds,
        fumbles: row.fumbles_total,
        fumblesLost: row.fumbles_lost_total,
        firstDowns: (row.rushing_first_downs ?? 0) + (row.receiving_first_downs ?? 0),
        targetShare: row.target_share,
        airYardsShare: row.air_yards_share,
        wopr: row.wopr,
      },
    };
  }
  if (position === 'K') {
    return {
      ...base,
      family: 'K',
      snapPct: null,
      stats: {
        fgMade: row.fg_made,
        fgMissed: (row.fg_missed ?? 0) + (row.fg_blocked ?? 0),
        fg50Plus: (row.fg_made_50_59 ?? 0) + (row.fg_made_60_ ?? 0),
        xpMade: row.pat_made,
      },
    };
  }
  return {
    ...base,
    family: 'IDP',
    snapPct: pct(row.defense_pct),
    stats: {
      soloTackles: row.def_tackles_solo,
      assistTackles: row.def_tackle_assists,
      sacks: row.def_sacks,
      tacklesForLoss: row.def_tackles_for_loss,
      interceptions: row.def_interceptions,
      passesDefended: row.def_pass_defended,
      forcedFumbles: row.def_fumbles_forced,
      fumbleRecoveries: row.fumble_recovery_opp,
      qbHits: row.def_qb_hits,
      tds: row.def_tds,
    },
  };
}

function defLine(row: DefWeekRow): ContractStatLine {
  const home = row.home_team != null && row.home_team === row.team;
  const pointsAllowed = home ? row.away_score : row.home_score;
  return {
    family: 'DEF',
    playerId: `DEF-${row.team}`,
    week: row.week,
    teamPlayedFor: row.team,
    opponent: row.opponent_team,
    home,
    snapPct: null,
    position: 'DEF',
    stats: {
      pointsAllowed,
      yardsAllowed: row.yards_allowed,
      sacks: row.def_sacks,
      interceptions: row.def_interceptions,
      fumbleRecoveries: row.fumble_recovery_opp,
      tds: (row.def_tds ?? 0) + (row.special_teams_tds ?? 0),
      safeties: row.def_safeties,
    },
  };
}

/** One statLines page; the synthesized DEF lines ride the final page. */
export async function seasonStatLines(
  pool: Pool,
  season: number,
  after: string | null | undefined,
  limitArg: number | null | undefined,
): Promise<StatLinePage> {
  const limit = Math.max(1, Math.min(STAT_PAGE_CAP, limitArg ?? STAT_PAGE_CAP));
  const cursor = decodeCursor(after);
  const rows = await findStatPage(pool, season, cursor.playerId, cursor.week, limit);
  const items = rows
    .map(playerLine)
    .filter((line): line is ContractStatLine => line != null);
  const lastRow = rows.at(-1);
  if (rows.length === limit && lastRow) {
    return { items, nextCursor: encodeCursor(lastRow.player_id, lastRow.week) };
  }
  // final page: append the team-defense weeks (bounded: 32 teams x 18 weeks)
  const defRows = await findDefWeeks(pool, season);
  items.push(...defRows.map(defLine));
  return { items, nextCursor: null };
}

/** The dataFreshness payload from the ingest ledger. */
export async function dataFreshness(pool: Pool): Promise<ContractFreshness> {
  const rows = await findFreshness(pool);
  const at = (dataset: string): string | null => {
    const row = rows.find((candidate) => candidate.dataset === dataset);
    return row?.loaded_at ? row.loaded_at.toISOString() : null;
  };
  return {
    playersLoadedAt: at('players'),
    statsLoadedAt: at('stats_player_week'),
    gamesLoadedAt: at('schedules'),
  };
}
