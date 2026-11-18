/** The player/team/game/stat contract fields (ADR-0016, ADR-0017; shapes per
 * docs/api-contract/02-field-mapping.md and the frontend specs' §9). */
import { builder } from '../../../graphql/builder.js';
import { getPool } from '../../../db/pool.js';
import {
  dataFreshness,
  seasonGames,
  seasonPlayers,
  seasonStatLines,
  seasonTeams,
  type ContractFreshness,
  type ContractGame,
  type ContractPlayer,
  type ContractStatLine,
  type ContractTeam,
  type StatLinePage,
} from '../service/nfl.service.js';

const PlayerRef = builder.objectRef<ContractPlayer>('Player');
PlayerRef.implement({
  description: 'One NFL player (or a synthesized team-defense row).',
  fields: (fieldBuilder) => ({
    id: fieldBuilder.exposeID('id', { nullable: false }),
    name: fieldBuilder.exposeString('name', { nullable: false }),
    position: fieldBuilder.exposeString('position', { nullable: false }),
    team: fieldBuilder.exposeString('team', { nullable: true }),
    jerseyNumber: fieldBuilder.exposeInt('jerseyNumber', { nullable: true }),
    age: fieldBuilder.exposeInt('age', { nullable: true }),
    heightIn: fieldBuilder.exposeInt('heightIn', { nullable: true }),
    weightLb: fieldBuilder.exposeInt('weightLb', { nullable: true }),
    college: fieldBuilder.exposeString('college', { nullable: true }),
    rookieYear: fieldBuilder.exposeInt('rookieYear', { nullable: true }),
    yearsExp: fieldBuilder.exposeInt('yearsExp', { nullable: true }),
    draftYear: fieldBuilder.exposeInt('draftYear', { nullable: true }),
    draftRound: fieldBuilder.exposeInt('draftRound', { nullable: true }),
    draftPick: fieldBuilder.exposeInt('draftPick', { nullable: true }),
    injuryStatus: fieldBuilder.exposeString('injuryStatus', { nullable: true }),
    practiceStatus: fieldBuilder.exposeString('practiceStatus', { nullable: true }),
  }),
});

const TeamRef = builder.objectRef<ContractTeam>('Team');
TeamRef.implement({
  description: 'One NFL team with venue facts and the derived bye week.',
  fields: (fieldBuilder) => ({
    abbr: fieldBuilder.exposeString('abbr', { nullable: false }),
    city: fieldBuilder.exposeString('city', { nullable: false }),
    nickname: fieldBuilder.exposeString('nickname', { nullable: false }),
    name: fieldBuilder.exposeString('name', { nullable: false }),
    conference: fieldBuilder.exposeString('conference', { nullable: false }),
    division: fieldBuilder.exposeString('division', { nullable: false }),
    stadium: fieldBuilder.exposeString('stadium', { nullable: true }),
    roof: fieldBuilder.exposeString('roof', { nullable: true }),
    surface: fieldBuilder.exposeString('surface', { nullable: true }),
    headCoach: fieldBuilder.exposeString('headCoach', { nullable: true }),
    byeWeek: fieldBuilder.exposeInt('byeWeek', { nullable: true }),
  }),
});

const GameRef = builder.objectRef<ContractGame>('Game');
GameRef.implement({
  description: 'One game of a season (nflverse carries no preseason rows).',
  fields: (fieldBuilder) => ({
    id: fieldBuilder.exposeID('id', { nullable: false }),
    season: fieldBuilder.exposeInt('season', { nullable: false }),
    phase: fieldBuilder.exposeString('phase', { nullable: false }),
    week: fieldBuilder.exposeInt('week', { nullable: false }),
    kickoff: fieldBuilder.exposeString('kickoff', { nullable: false }),
    homeTeam: fieldBuilder.exposeString('homeTeam', { nullable: false }),
    awayTeam: fieldBuilder.exposeString('awayTeam', { nullable: false }),
    homeScore: fieldBuilder.exposeInt('homeScore', { nullable: true }),
    awayScore: fieldBuilder.exposeInt('awayScore', { nullable: true }),
    overtime: fieldBuilder.exposeBoolean('overtime', { nullable: false }),
    final: fieldBuilder.exposeBoolean('final', { nullable: false }),
    stadium: fieldBuilder.exposeString('stadium', { nullable: true }),
    roof: fieldBuilder.exposeString('roof', { nullable: true }),
    surface: fieldBuilder.exposeString('surface', { nullable: true }),
    temperatureF: fieldBuilder.exposeInt('temperatureF', { nullable: true }),
    windMph: fieldBuilder.exposeInt('windMph', { nullable: true }),
    spreadLine: fieldBuilder.exposeFloat('spreadLine', { nullable: true }),
    totalLine: fieldBuilder.exposeFloat('totalLine', { nullable: true }),
    favorite: fieldBuilder.exposeString('favorite', { nullable: true }),
    homeQb: fieldBuilder.exposeString('homeQb', { nullable: true }),
    awayQb: fieldBuilder.exposeString('awayQb', { nullable: true }),
    homeCoach: fieldBuilder.exposeString('homeCoach', { nullable: true }),
    awayCoach: fieldBuilder.exposeString('awayCoach', { nullable: true }),
    homeRestDays: fieldBuilder.exposeInt('homeRestDays', { nullable: true }),
    awayRestDays: fieldBuilder.exposeInt('awayRestDays', { nullable: true }),
    divisionGame: fieldBuilder.exposeBoolean('divisionGame', { nullable: false }),
  }),
});

/** Shared identity fields (player spec §9.2, PE4). */
const StatLineRef = builder.interfaceRef<ContractStatLine>('StatLine');
StatLineRef.implement({
  description: 'Shared identity of a weekly stat line; concrete type per position family.',
  fields: (fieldBuilder) => ({
    playerId: fieldBuilder.exposeID('playerId', { nullable: false }),
    week: fieldBuilder.exposeInt('week', { nullable: false }),
    teamPlayedFor: fieldBuilder.exposeString('teamPlayedFor', { nullable: false }),
    opponent: fieldBuilder.exposeString('opponent', { nullable: true }),
    home: fieldBuilder.exposeBoolean('home', { nullable: false }),
    snapPct: fieldBuilder.exposeFloat('snapPct', { nullable: true }),
  }),
});

/** Declares one concrete StatLine type whose fields read the stats record. */
function statLineType(name: string, family: ContractStatLine['family'], keys: string[]): void {
  const ref = builder.objectRef<ContractStatLine>(name);
  ref.implement({
    interfaces: [StatLineRef],
    isTypeOf: (value) => (value as ContractStatLine).family === family,
    fields: (fieldBuilder) => {
      const fields: Record<string, ReturnType<typeof fieldBuilder.float>> = {};
      for (const key of keys) {
        fields[key] = fieldBuilder.float({
          nullable: true,
          resolve: (line) => line.stats[key] ?? null,
        });
      }
      return fields;
    },
  });
}

statLineType('QbStatLine', 'QB', [
  'attempts', 'completions', 'passYards', 'passTds', 'interceptions',
  'sacksTaken', 'sackYards', 'carries', 'rushYards', 'rushTds',
  'fumbles', 'fumblesLost', 'firstDowns',
]);
statLineType('RbStatLine', 'RB', [
  'carries', 'rushYards', 'rushTds', 'targets', 'receptions', 'recYards',
  'recTds', 'fumbles', 'fumblesLost', 'firstDowns', 'targetShare',
  'airYardsShare', 'wopr',
]);
statLineType('WrTeStatLine', 'WRTE', [
  'targets', 'receptions', 'recYards', 'recTds', 'carries', 'rushYards',
  'fumbles', 'fumblesLost', 'firstDowns', 'targetShare', 'airYardsShare', 'wopr',
]);
statLineType('KStatLine', 'K', ['fgMade', 'fgMissed', 'fg50Plus', 'xpMade']);
statLineType('DefStatLine', 'DEF', [
  'pointsAllowed', 'yardsAllowed', 'sacks', 'interceptions',
  'fumbleRecoveries', 'tds', 'safeties',
]);
statLineType('IdpStatLine', 'IDP', [
  'soloTackles', 'assistTackles', 'sacks', 'tacklesForLoss', 'interceptions',
  'passesDefended', 'forcedFumbles', 'fumbleRecoveries', 'qbHits', 'tds',
]);

const StatLinePageRef = builder.objectRef<StatLinePage>('StatLinePage');
StatLinePageRef.implement({
  description: 'One keyset page of stat lines (cap 5,000; player spec PE4).',
  fields: (fieldBuilder) => ({
    items: fieldBuilder.field({
      type: [StatLineRef],
      nullable: false,
      resolve: (page) => page.items,
    }),
    nextCursor: fieldBuilder.exposeString('nextCursor', { nullable: true }),
  }),
});

const FreshnessRef = builder.objectRef<ContractFreshness>('DataFreshness');
FreshnessRef.implement({
  description: 'When each dataset last loaded (drives the freshness/stale UI).',
  fields: (fieldBuilder) => ({
    playersLoadedAt: fieldBuilder.exposeString('playersLoadedAt', { nullable: true }),
    statsLoadedAt: fieldBuilder.exposeString('statsLoadedAt', { nullable: true }),
    gamesLoadedAt: fieldBuilder.exposeString('gamesLoadedAt', { nullable: true }),
  }),
});

builder.queryFields((fieldBuilder) => ({
  players: fieldBuilder.field({
    description: 'Every fantasy-relevant player for a season, plus the 32 team defenses.',
    type: [PlayerRef],
    nullable: false,
    args: { season: fieldBuilder.arg.int({ required: true }) },
    resolve: (_root, args) => seasonPlayers(getPool(), args.season),
  }),
  teams: fieldBuilder.field({
    description: 'All 32 teams with venue facts and the derived bye week.',
    type: [TeamRef],
    nullable: false,
    args: { season: fieldBuilder.arg.int({ required: true }) },
    resolve: (_root, args) => seasonTeams(getPool(), args.season),
  }),
  games: fieldBuilder.field({
    description: 'Every game of a season, all phases the source carries.',
    type: [GameRef],
    nullable: false,
    args: { season: fieldBuilder.arg.int({ required: true }) },
    resolve: (_root, args) => seasonGames(getPool(), args.season),
  }),
  statLines: fieldBuilder.field({
    description: 'Weekly stat lines for a season, keyset-paged with a hard cap.',
    type: StatLinePageRef,
    nullable: false,
    args: {
      season: fieldBuilder.arg.int({ required: true }),
      after: fieldBuilder.arg.string(),
      limit: fieldBuilder.arg.int(),
    },
    resolve: (_root, args) => seasonStatLines(getPool(), args.season, args.after, args.limit),
  }),
  dataFreshness: fieldBuilder.field({
    description: 'When each dataset the screens read was last loaded.',
    type: FreshnessRef,
    nullable: false,
    resolve: () => dataFreshness(getPool()),
  }),
}));
