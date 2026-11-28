# Step 2 — Field → MySQL mapping (the supply side of the contract)

**Date:** 2026-11-17 · **Input:** [01-page-needs.md](01-page-needs.md) (Step 1) and the frontend specs' §9 contract sketches (`runpure-ff-planning/specs/`). **Output:** the Pothos types in `src/modules/nfl/graphql/nfl.graphql.ts`; the committed `schema.graphql` is the formal contract (ADR-0016).

**Conventions:** camelCase GraphQL field ← snake_case column. Computed-by-frontend values (fantasy points, PPG, ranks, matchup difficulty — ADR-0007) are *not* served; their raw inputs are. All reads hand-written SQL (ADR-0010).

## Player ← `player` (+ `injury_report`)

| GraphQL | Source |
|---|---|
| id | `gsis_id` |
| name | `display_name` |
| position | `position_group` mapped: QB/RB/WR/TE as-is · SPEC with `position='K'` → K · DB/LB/DL as-is · others excluded |
| team | `latest_team` |
| jerseyNumber / heightIn / weightLb / college | `jersey_number` / `height` / `weight` / `college_name` |
| age | computed in SQL from `birth_date` |
| rookieYear / yearsExp | `rookie_season` / `years_of_experience` |
| draftYear / draftRound / draftPick | `draft_year` / `draft_round` / `draft_pick` |
| injuryStatus | latest `injury_report.report_status` for the season (Out→`O`, Questionable→`Q`, Doubtful→`O`) · `player.status = 'RES'` → `IR` |
| practiceStatus | same report's `practice_status` |

**Population:** players with ≥1 `player_week_stat` row that season, or on an active roster at a mapped position — plus **32 synthesized DEF rows** (`id = DEF-<abbr>`, name = team name) so team defenses appear as list rows, as the frontend renders them.

## Team ← `team` (+ derived from `game`)

| GraphQL | Source |
|---|---|
| abbr / nickname / name / conference / division | `team_abbr` / `team_nick` / `team_name` / `team_conf` / `team_division` |
| city | `team_name` with the nickname stripped |
| stadium / roof / surface | the team's latest **home** `game` row that season |
| headCoach | that team's coach column from its latest game |
| byeWeek | the REG week 1–18 with no `game` row for the team |

## StatLine (interface + 6 types) ← `player_week_stat` (+ `snap_count`, `team_week_stat`, `game`)

Shared: playerId←`player_id` · week · teamPlayedFor←`team` · opponent←`opponent_team` · home (team = `game.home_team`) · snapPct←`snap_count.offense_pct`×100 (defense_pct for IDP; join through `player_source` (`source_code = 'pfr'`) + `game_id`; ADR-0023).

| Type | Fields ← columns |
|---|---|
| QbStatLine | attempts, completions, passYards←`passing_yards`, passTds←`passing_tds`, interceptions←`passing_interceptions`, sacksTaken←`sacks_suffered`, sackYards←`sack_yards_lost`, carries, rushYards←`rushing_yards`, rushTds←`rushing_tds`, fumbles←`fumbles_total`, fumblesLost←`fumbles_lost_total`, firstDowns←`passing_first_downs`+`rushing_first_downs` |
| RbStatLine | carries, rushYards, rushTds, targets, receptions, recYards←`receiving_yards`, recTds←`receiving_tds`, fumbles/fumblesLost (totals), firstDowns←rushing+receiving, targetShare←`target_share`, airYardsShare←`air_yards_share`, wopr |
| WrTeStatLine | targets, receptions, recYards, recTds, carries, rushYards, fumbles/fumblesLost, firstDowns, targetShare, airYardsShare, wopr |
| KStatLine | fgMade←`fg_made`, fgMissed←`fg_missed`+`fg_blocked`, fg50Plus←`fg_made_50_59`+`fg_made_60_`, xpMade←`pat_made` |
| IdpStatLine | soloTackles←`def_tackles_solo`, assistTackles←`def_tackle_assists`, sacks←`def_sacks`, tacklesForLoss←`def_tackles_for_loss`, interceptions←`def_interceptions`, passesDefended←`def_pass_defended`, forcedFumbles←`def_fumbles_forced`, fumbleRecoveries←`fumble_recovery_opp`, qbHits←`def_qb_hits`, tds←`def_tds` |
| DefStatLine (synthesized per team-week) | pointsAllowed←opponent's score from `game` · yardsAllowed←opponent's `team_week_stat` passing+rushing yards · sacks←own `def_sacks` · interceptions←own `def_interceptions` · fumbleRecoveries←own `fumble_recovery_opp` · tds←own `def_tds`+`special_teams_tds` · safeties←own `def_safeties` |

**Paging:** keyset on (`player_id`, `week`), `after` = opaque `playerId:week` cursor, `limit` capped at 5,000 (player spec PE4). DEF lines are appended by the service after the player pages.

## Game ← `game`

| GraphQL | Source |
|---|---|
| id / season / week | `game_id` / `season` / `week` |
| phase | `game_type`: REG→REG · WC/DIV/CON/SB→POST (**nflverse carries no preseason** — the PRE phase is honestly empty) |
| kickoff | `gameday` + `gametime` (Eastern) → ISO instant |
| homeTeam / awayTeam / homeScore / awayScore / overtime | columns; final = `home_score IS NOT NULL` |
| stadium / roof / surface / temperatureF←`temp` / windMph←`wind` | columns |
| spreadLine / totalLine | `ABS(spread_line)` / `total_line`; favorite = `spread_line > 0 ? home : away` (nflverse: positive favours home) |
| homeQb / awayQb | `player.display_name` through `game.home_qb_id` / `away_qb_id` (ADR-0026) |
| homeCoach / awayCoach | `home_coach` / `away_coach` |
| homeRestDays / awayRestDays / divisionGame | `home_rest` / `away_rest` / `div_game` |

## DataFreshness ← `ingest_ledger`

`MAX(finished_at)` where `status='loaded'`: playersLoadedAt←`players` · statsLoadedAt←`stats_player_week` · gamesLoadedAt←`schedules`.

## Deliberate deviations from the planning-spec sketches (reconciled here)

1. **`teamWeekStats` query dropped** — the spec listed it to let the client assemble DEF scoring; serving ready `DefStatLine` rows makes it redundant. Revisit if a later screen needs raw team weeks.
2. **`mySettings` / `saveSettings` deferred** to the auth milestone (owner, 2026-11-17: no auth locally; settings-per-account needs real accounts). The frontend's localStorage mirror remains the interim store (foundation spec F7 interface unchanged).
3. **Preseason**: no source rows; the phase exists in the enum, returns no games.
