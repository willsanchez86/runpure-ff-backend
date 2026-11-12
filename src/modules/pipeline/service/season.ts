/** Current-season rule (ETL spec D6) and the seasons each run loads (ADR-0006, ADR-0013). */
import { env } from '../../../config/env.js';
import type { DatasetDef, SeasonRollover } from './datasets.js';
import type { JobKind } from '../model/pipeline.model.js';

/** Ledger season used for single-file datasets. */
export const SINGLE_FILE_SEASON = 0;

/** Today's calendar date as YYYY-MM-DD in the pipeline's time zone. */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The Wednesday after Labor Day (the first Monday of September), as YYYY-MM-DD. */
export function seasonOpenerSwitch(year: number): string {
  const septemberFirst = new Date(Date.UTC(year, 8, 1));
  const toMonday = (1 - septemberFirst.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, 8, 1 + toMonday + 2)).toISOString().slice(0, 10);
}

/**
 * The NFL season a dataset should treat as current (ETL spec D6): the season in progress
 * on today's date. Between seasons, rosters switch on March 15 and every other seasonal
 * dataset on the Wednesday after Labor Day, as nflverse publishes them. CURRENT_SEASON
 * overrides the rule.
 */
export function currentSeason(rollover: SeasonRollover = 'season_opener', now: Date = new Date()): number {
  if (env.currentSeasonOverride) return env.currentSeasonOverride;
  const today = todayIn(env.timezone, now);
  const year = Number(today.slice(0, 4));
  const switchDate = rollover === 'march_15' ? `${year}-03-15` : seasonOpenerSwitch(year);
  return today >= switchDate ? year : year - 1;
}

/** Season range for a backfill. */
export interface SeasonRange {
  from: number;
  /** Default: the dataset's current season. */
  to?: number;
}

/**
 * Which seasons a run loads for a dataset (ADR-0006, ADR-0013).
 * Scheduled ingest: current season only; the file for a season holds every week, so
 * stat corrections are covered by re-reading the current season's file.
 * Backfill: the full history range for history datasets.
 */
export function seasonsToLoad(def: DatasetDef, kind: JobKind, range?: SeasonRange): number[] {
  const current = currentSeason(def.rollover);
  switch (def.scope) {
    case 'single_file':
      return [SINGLE_FILE_SEASON];
    case 'current_season':
      return [current];
    case 'history': {
      if (kind === 'ingest') return [current];
      const from = range?.from ?? env.historyStartSeason;
      const to = range?.to ?? current;
      const seasons: number[] = [];
      for (let s = from; s <= to; s++) seasons.push(s);
      return seasons;
    }
  }
}
