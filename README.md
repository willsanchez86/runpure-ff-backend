# Runpure FF backend

Node.js 24 + Express 5 + TypeScript, built as a layered modular monolith (ADR-0008). It
holds the GraphQL API, the nflverse ETL pipeline with its daily scheduled run, and the
one-time history backfill.

Three choices shape the code: MySQL is the only store (ADR-0005), rows are mapped by hand
with no ORM (ADR-0010), and schema changes are applied by hand from `sql/` — no migration
runner (ADR-0011) and no transform library (ADR-0012).

Planning documents live in the `runpure-ff-planning` repo; the pipeline is specified there
in `specs/ff-data-etl-storage-spec.md`.

## Contents

- [Setup](#setup)
  - [Running the tests](#running-the-tests)
- [API](#api-adr-0014-to-adr-0017)
- [Layout](#layout)
- [Commands](#commands)
- [Mapping a dataset](#mapping-a-dataset)
- [Load rules](#load-rules)
- [Scheduled ingest](#scheduled-ingest)
- [Operating the pipeline](#operating-the-pipeline)

## Setup

Local development needs Node.js 24 and Docker. The database runs in Docker, and the schema
is applied by hand (ADR-0011) — there is no migration runner.

1. **Install dependencies:** `npm install`. Its `prepare` script points git at `.githooks`.
2. **Create your env file:** `cp .env.example .env`, then fill in the required values:
   - `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` — the Docker database.
   - `DATABASE_URL` — how the app and jobs connect, e.g.
     `mysql://<MYSQL_USER>:<MYSQL_PASSWORD>@127.0.0.1:3306/<MYSQL_DATABASE>`.
   - `GOOGLE_APPLICATION_CREDENTIALS` — a Firebase service-account key file kept outside the
     repo (ADR-0015). Needed only for the GraphQL API, not the pipeline jobs.
3. **Start the database:** `docker compose up -d`. This runs MySQL 8.4 as `runpure-mysql`
   on `127.0.0.1:3306` (`MYSQL_PORT` overrides). The `MYSQL_*` values are read only on the
   first start; to change them, run `docker compose down -v` (which deletes the data) and
   start again.
4. **Apply the schema:** run every `sql/*.sql` file in numeric order against the database,
   with MySQL Workbench or the `mysql` client. `0001`-`0002` are the pipeline and user
   tables; `0003`-`0012` are the ten data tables.
5. **Load data and run:** `npm run backfill -- --from 2022 --to 2026` once to load history,
   then `npm run dev` to serve the API and run the daily ingest. Use `npm run ingest` for a
   one-off incremental run.

### Running the tests

Unit tests need no setup — `npm test` runs them.

The integration tests load against a real database, so they run only when `TEST_DATABASE_URL`
is set, and never touch your development data:

1. Create a throwaway schema (e.g. `runpure_test`) and apply `sql/*.sql` to it.
2. Set `TEST_DATABASE_URL` to that schema, and set `DATABASE_URL` to the same value. (The
   GraphQL integration test runs only when the two match — a guard against hitting real data.)
3. Run `npm test`.

## API (ADR-0014 to ADR-0017)

- **Endpoint:** one GraphQL endpoint at `/graphql`, built code-first with Pothos and served
  by GraphQL Yoga. `npm run schema` prints the contract to `schema.graphql`; commit it with
  the change that produced it (ADR-0016).
- **Auth:** every request needs a Firebase ID token (`Authorization: Bearer <token>`) for an
  account in the `users` table; otherwise 401 or 403 (ADR-0015).
- **CORS and rate limiting:** CORS allows only `FRONTEND_ORIGIN`, and requests are
  rate-limited per client IP.
- **Trusted documents only:** only documents in `persisted/` run. `GRAPHQL_ALLOW_ARBITRARY=true`
  lifts this for local development only.
- **Operator fields:** `pipelineRuns` and `ingestLedger` need `users.is_operator`. Until the
  frontend exists, read `job_run` and `ingest_ledger` directly in MySQL.
- **Health check:** `GET /health` is a plain probe for the host, outside the API.

## Layout

```
src/
  app.ts                     Express app wiring
  server.ts                  Process entry: HTTP server + scheduler + shutdown
  config/env.ts              Environment variables
  db/pool.ts, db/lock.ts     MySQL pool (UTC); GET_LOCK run lock (ADR-0006)
  middleware/                request log, Firebase token check, error handler
  routes/index.ts            mounts /health and the GraphQL endpoint
  graphql/                   Pothos builder, schema, Yoga server, persisted store
  modules/
    health/                  controller, routes
    account/                 users model; `me` field
    pipeline/
      model/                 ingest_ledger and job_run queries
      service/
        datasets.ts          nflverse dataset registry + column mappings
        season.ts            current season (D6); which seasons each run loads
        nflverse.service.ts  version HEAD + guarded streamed download (host allowlist, timeouts, caps)
        load.service.ts      TEMPORARY staging -> swap in one transaction; §8 row-count block
        validate.service.ts  header check, drop/dedupe, reference + row-count warnings (§8)
        ingest.service.ts    one pipeline run (lock, ledger, per-piece load)
      graphql/               pipelineRuns, ingestLedger (operator accounts only)
  scheduler/index.ts         cron schedule that calls the ingest entry point
  jobs/                      CLI entry points: ingest, backfill, headers, spike
sql/                         hand-applied schema statements, in order
persisted/                   trusted documents
```

Dependencies run one way: `jobs -> modules/*/service -> modules/*/model -> db`, with
`config/env.ts` and `datasets.ts` the leaves everything reads. Nothing imports upward; an
upward import is the first sign the layering is breaking.

## Commands

```
npm run spike        proves GraphQL Yoga runs on this Express 5 app (ADR-0017 item 7)
npm run dev          API + scheduler, reloading on change
npm run schema       print schema.graphql
npm run headers      print each dataset's CSV columns and a sample row (for mapping)
npm run ingest       one incremental run now (current season only)
npm run backfill     one-time history load: -- --from 2022 --to 2026 [--dataset name]
npm run typecheck    tsc --noEmit
npm run lint         ESLint: JSDoc required on exports (also runs before each commit and in CI)
npm test             node:test: unit tests always; DB-gated integration tests when TEST_DATABASE_URL is set
npm run build && npm start
```

`lint` runs before each commit and in CI. `test` does not yet run in CI, so run `npm test`
locally before pushing a pipeline change.

## Mapping a dataset

1. `npm run headers -- --dataset stats_player_week` to see the columns.
2. Write the `CREATE TABLE` (ETL spec §7.2 and data dictionary) in a new `sql/000N_*.sql`
   file and apply it by hand.
3. Fill `table` and `columns` for that dataset in `datasets.ts`.
4. `npm run ingest -- --dataset stats_player_week`.

Datasets without a mapping are skipped and reported.

**Changing an existing table** (a column added, renamed, or retyped upstream): edit its
`sql/` file and apply the change by hand — `sql/README.md` covers `ALTER` vs
drop-and-recreate.

**Keep three places in step:** the DDL in `sql/`, the mapping in `datasets.ts`, and the data
dictionary in `runpure-ff-planning`. Two guards catch drift on the next run:

- The §8 header check fails a load whose file is missing a mapped column.
- Staging is built as `CREATE TEMPORARY TABLE ... LIKE <table>`, so the live table is the
  type contract — a mapped column absent from it fails the load.

**Keep the engine generic:** `datasets.ts` is the one place a dataset's shape is described. A
dataset-specific need — an optional column, a dedupe tiebreaker, a reference to check —
belongs in its `DatasetDef` metadata, never in a branch inside the download/validate/load
services.

## Load rules

- **One piece = one file:** a dataset × season (season 0 for single-file datasets) (D5).
- **ETag skip:** a piece is skipped when its ETag matches the ledger's last successful load.
- **Staging then swap:** rows stream into `<table>__staging` in batches, then one transaction
  replaces the target rows and commits — that season for `history` datasets, the whole table
  otherwise.
- **What each scope keeps:** `history` keeps 2022-current (ADR-0006); `current_season`
  (play-by-play, depth charts) keeps only the current season (ADR-0013); `single_file` is
  replaced whole.
- **Season rollover (D6):** rosters switch to the new season on March 15, every other seasonal
  dataset on the Wednesday after Labor Day. `CURRENT_SEASON` overrides both.
- **NULLs:** empty strings and `NA` become `NULL`.

**Validation (ETL spec §8)** — before a load commits:

- The file header must contain every mapped column (injuries accepts either of its two headers).
- Rows with an empty natural key are dropped; injuries are deduped (latest `date_modified`
  wins, else last in file).
- A sharp row-count drop blocks the load before the swap (`ROW_COUNT_MIN_RATIO`, default 0.5).
- References with no parent row, and row-count drops, are recorded as warnings in `job_run.error`.

**Download hardening (ETL spec §4.2):**

- Redirects are followed by hand against an https host allowlist (`RELEASE_HOST_ALLOWLIST`).
- Header and inter-chunk idle timeouts, plus download and gzip-decompression byte caps, guard
  a stalled or oversized fetch.
- The source base is `RELEASE_BASE`. Staging is a session `TEMPORARY` table, discarded when
  the connection closes.

## Scheduled ingest

New data arrives two ways: the one-time `npm run backfill` loads history once, then a daily
scheduled `ingest` keeps the current season fresh (ETL spec D7, D12).

- **When:** once a day at `PIPELINE_CRON` (default `0 6 * * *`, i.e. 06:00) in `PIPELINE_TZ`
  (default `America/New_York`, so 06:00 Eastern, tracking EST/EDT). Both are overridable.
- **Where:** the scheduler runs inside the server process (`npm run dev`, or the deployed
  server). No running server means no automatic run; trigger one by hand with `npm run ingest`,
  or point an external cron at that command.
- **What it loads:** the current season only for `history` and `current_season` datasets, the
  whole file for `single_file` datasets. A piece whose source ETag matches the ledger's last
  successful load is skipped, so a normal day reloads only the files nflverse republished.
- **Season rollover is automatic:** rosters switch to the new season on March 15, every other
  seasonal dataset on the Wednesday after Labor Day (`CURRENT_SEASON` overrides).
- **Overlap:** a MySQL `GET_LOCK` run lock means a second run exits `skipped_locked` rather
  than running concurrently.
- **Idempotent:** a load replaces rows, it never appends — one transaction deletes the rows
  being replaced (that season, or the whole table) and inserts the staged rows, and `teams`
  upserts. Re-running a backfill or ingest overwrites the same rows, so it is always safe to
  run again.

Finished seasons are not re-fetched daily; to correct an old season, run a targeted backfill
(`npm run backfill -- --from 2024 --to 2024`).

## Operating the pipeline

Every run and every file it touches is recorded, so you diagnose from the database, not the
logs. `job_run` has one row per run with its `outcome` and piece counts; `ingest_ledger` has
one row per `(dataset, season)` (unique on that pair) with its `status`, `source_etag`,
`rows_loaded`, and `error`. Read them in MySQL, or through the operator GraphQL fields
`pipelineRuns` and `ingestLedger` (which need `users.is_operator = 1`).

```sql
SELECT id, kind, outcome, pieces_loaded, pieces_skipped, pieces_failed, finished_at
FROM job_run ORDER BY id DESC LIMIT 10;

SELECT dataset, season, status, rows_loaded, error
FROM ingest_ledger ORDER BY dataset, season;
```

**Outcomes.** A run is `ok` when no piece failed, `failed` when one or more did (the rest
still loaded), or `skipped_locked` when another run held the lock. A failed piece is isolated:
the run finishes and the next run retries it.

**Warnings vs. failures.** Warnings never fail a run. They are written to `job_run.error` with
a `WARNINGS:` prefix — the load kept its data but noticed something, such as a player/game
reference with no parent row, or a duplicate injury key kept by file order. A piece that
actually failed has `status = 'failed'` and its reason in that row's `ingest_ledger.error`.

**Common cases:**

- **A piece failed.** Read its `ingest_ledger.error`, fix the cause, and re-run the same
  command; loaded pieces skip on ETag, so only the failed piece reloads.
- **A load was blocked for too few rows.** The error names the staged count and the threshold
  (`ROW_COUNT_MIN_RATIO`, default 0.5). The block is independent of `--force`. If the smaller
  file is genuinely correct, re-run that piece with a lower `ROW_COUNT_MIN_RATIO` in the
  environment (`0` disables the check). Otherwise the source was truncated and the block saved
  you — the previous data is intact.
- **A run won't start at all.** `DATABASE_URL` is wrong or MySQL is down (it throws before the
  first piece), or `job_run`/`ingest_ledger` are missing (apply `sql/0001`).
- **Everything reports "skipped".** Either the datasets have no mapping, or every ETag matched;
  add `--force` to reload unchanged files.
- **Stuck lock.** A crashed run's `GET_LOCK` clears when its connection closes. If a run reports
  `skipped_locked` with nothing else running, a connection is still open — restart the server
  (or the holding process) and re-run.

**Re-running is always safe.** Loads replace rather than append (see Scheduled ingest), so any
command converges to the same state. To reload a finished season, name it:
`npm run backfill -- --from 2024 --to 2024`.
