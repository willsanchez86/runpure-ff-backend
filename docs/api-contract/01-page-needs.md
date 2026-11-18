# Step 1 — Page needs inventory (what the frontend-as-designed renders)

**Date:** 2026-11-16 · **Source of truth:** the Phase 1 prototype (`runpure-ff-planning/prototypes/phase1/app.js`, `data.js`). This is the *needs* side of the contract. Step 2 maps each field to a MySQL source.

**Reading the tags:**
- **raw** — a stored stat the API returns directly.
- **computed** — the frontend derives it client-side from raw stats (ADR-0007: no fantasy points stored). The API must return the *inputs*, not the computed value. Marked so Step 2 maps the inputs.
- **stub** — a designed-for placeholder with **no Phase 1 data source**; **out of contract scope** (listed in §4, not mapped).

---

## 1. Players list

### 1.1 Row anatomy (always rendered, every row) — `app.js:546-560`
| Field | Tag | Note |
|---|---|---|
| Player name | raw | `display_name` |
| Position | raw | |
| NFL team | raw | current team |
| Bye week | computed | derived from the schedule (team with no game that week) |
| Injury status (QUES/OUT/IR) | raw | from injury report / roster status |
| Next kickoff + opponent | computed | from the schedule (next game for the team) |
| News chip (unread/none) | stub | injury-status-driven only |

### 1.2 Columns — skill positions (QB/RB/WR/TE) — `COLS` / `colsOffered` `app.js:232-331`
Core: **Total** (computed), **PPG** (computed, + GP), **High** (computed), **Low** (computed), **Volatility** (computed, 3+ GP), **GP** (computed).
Rank: **Pos rank** (computed, by season fantasy total), **Tier** (computed from rank).
Usage/efficiency: **SNP%** (raw), **TGT%** (computed: targets ÷ team pass att), **Tgt share** (raw), **AY%** (raw), **WOPR** (raw), **Y/C** (computed), **Y/Tgt** (computed), **Catch%** (computed), **1D** (raw, per-game aware).
Counting (per-game-toggle aware): **Rec, Tgt, Rec yd, Car, Rush yd, Pass yd, Pass TD** (all raw).
Splits: **Home/Away** (computed), **vs Tough/Easy** (computed).
Schedule: **Next matchup** + difficulty rank (computed), **Bye** (computed), **Weekly** trend sparkline (raw series).
**Proj (est)** — stub.

### 1.3 Columns — Kicker — `colsOffered('colsK')`
Core + rank/tier + **FGM, FGA, FG%, 50+, XPM** (raw; FG% computed) + splits + matchup + bye + trend + proj(stub).

### 1.4 Columns — Team defense (DEF) — `colsOffered('colsDEF')`
Core + rank/tier + **Sacks, INT, FR, TD, PA/g, Yds/g** (raw/assembled; PA & YA are the DST-assembly path) + splits + matchup + bye + trend + proj(stub).

### 1.5 Columns — IDP (DB/DL/LB) — `colsOffered('colsIDP')`
Core + rank/tier + **Tkl, Sacks, INT, PD** (raw) + **SNP%** + splits + matchup + bye + trend + proj(stub).

### 1.6 Filters that bind to data — `app.js` control strip
Position, NFL team, injury status, bye week, minimum games played, **rookies** (`rookie_season`). (Free agents / watchlist = stub.)

---

## 2. Player card

### 2.1 Header / hero — `heroBlock` `app.js:823`
Name, position, NFL team, jersey number. (★ watchlist / ADD = stub.)

### 2.2 Bio strip — `bioStrip` `app.js:835`
Skill/K/IDP: **Age** (computed from birth_date), **Height**, **Weight**, **Experience**, **College**, **Draft** (year/round/pick) — all raw.
DEF variant: team name, division, stadium (raw, team reference).

### 2.3 Rankings strip — `rankingsStrip` `app.js:843`
**Pos rank** (computed), **Overall rank** (computed). **% Rostered**, **% Started** = stub.

### 2.4 Status row — `app.js:1074`
Injury status + "(Wk N)" (raw), Practice status (raw), Week-N matchup + difficulty (computed), team link.

### 2.5 News rail — `newsRail` `app.js:853` — **stub**

### 2.6 Overview tab — `app.js:1022`
Summary tiles: **Total, PPG (+GP), High, Low, Volatility** (computed). Usage snapshot (skill): **Snap%** (raw), **Target%** (computed), **Tgt share** (raw), **Air-yards%** (raw), **WOPR** (raw). Weekly **trend** (raw points series). **Consistency** floor–ceiling (computed).

### 2.7 Game log tab — `logSpec` `app.js:878`, `gameLogHeat` `app.js:903`
Per week: **WK**, **RESULT** (W/L + final score + OT — assembled from schedule; current season only), **OPP** (+ matchup chip for upcoming weeks). Then **FPTS** (computed) and position-specific stat sets (all raw):
- **QB:** SNP% · PASSING att, cmp, yd, td, int · RUSHING att, yd, ypc, td · SACKED sk, yds · FUMBLE fum, lost
- **RB:** SNP% · RUSHING att, yd, ypc, td · RECEIVING tgt, rec, yd, td · FUMBLE
- **WR/TE:** SNP% · RECEIVING tgt, rec, yd, Y/T, td · USAGE tgt%, ay%, wopr · FUMBLE
- **K:** KICKING fgm, fga, fg%, 50+, xpm
- **DEF:** DEFENSE sk, int, fr, td, saf · SCORING pa, ya (assembled)
- **IDP:** SNP% · TACKLES solo, ast, tot · IMPACT sk, tfl, int, pd, ff, fr

Season pills: 2022..current (multi-season). **PROJ** column = stub.

### 2.8 Splits tab — `splitsBlock` `app.js:801`
PPG (computed) by: **Home/Away**, **Indoor/Outdoor** (from roof/temp), **Surface** (grass/turf), **Tough/Even/Easy** (matchup), **Division**, **Month** — each with games played. Inputs: per-week points + each game's home/away, roof, surface, div_game, date, opponent.

### 2.9 Trends tab — `usagePanels` + `rankOverTime` `app.js:1041`
Usage small-multiples by week: **Snap%, Tgt share, Air-yards%, WOPR** (raw). **Positional rank over time** (computed, by week).

### 2.10 History tab — `careerTable` `app.js:964`
Year-by-year: **Season, Team, GP, Total, PPG, High, Low, Volatility, Pos rank** (computed from each season's raw lines). Transaction history + Projections-vs-actual = stub.

---

## 3. NFL scores & schedule

### 3.1 Controls — `app.js:1373`
Phase picker (preseason / regular / postseason), Week picker.

### 3.2 Game card — `gameCard` `app.js:1389`
Away & home: team name, division; final scores + OT, or kickoff day/time if unplayed; Final/Upcoming status; stadium; favorite + spread; over/under total. Team name → filters Players list. **Bye teams** list for the week.

### 3.3 Game detail (expand) — `app.js:1407`
Stadium + city, Roof, Surface, Temp, Wind, Line (favorite/spread), Total, **Starting QBs** (+team), **Head coaches**. All raw from the game row.

---

## 4. Designed stubs — EXCLUDED from the contract (no Phase 1 source)

Projections (PROJ column, Proj est, Projections-vs-actual) · % Rostered / % Started · News feed / news rail / news chip · Transaction history · Trending adds/drops · Watchlist (★) / ADD · Saved views · Export · Free-agents / on-my-teams filters. These are client-side placeholders; the contract does not expose them.

---

## 5. Gate check (Step 1 exit)

- **Pages present:** Players list ✓ · Player card (Overview ✓ Game log ✓ Splits ✓ Trends ✓ History ✓) · NFL scores & schedule ✓ · Game detail ✓.
- **Every rendered field captured:** list row + all position column sets + card header/bio/rankings/status + all 5 tabs + NFL card/detail ✓.
- **Stubs explicitly excluded:** §4 ✓.
- **Computed vs raw tagged** so Step 2 maps the raw inputs (fantasy points, PPG, volatility, ranks, splits, matchup difficulty are all client-computed per ADR-0007).

**Distinct raw/assembled data points to map in Step 2:** player bio (~10), per-week player stat line (position-specific, ~25 fields across positions), snap share, injury/practice status, usage metrics (tgt share, AY%, WOPR, targets), team-defense aggregate (6 assembled), game/schedule (teams, scores, OT, kickoff, venue, roof, surface, temp, wind, spread, total, QBs, coaches, bye), team reference (name, division, stadium, bye).
