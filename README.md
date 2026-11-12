# Runpure FF backend

Node.js 24 + Express 5 + TypeScript, layered modular monolith (ADR-0008). Holds the
GraphQL API, the nflverse ETL pipeline with its daily scheduled run, and the one-time
backfill. MySQL is the only store (ADR-0005). Rows are mapped by hand, no ORM
(ADR-0010); schema changes are applied by hand from `sql/` (ADR-0011); no transform
library (ADR-0012). Planning documents live in `runpure-ff-planning`; the pipeline is
specified in its `specs/ff-data-etl-storage-spec.md`.

## API (ADR-0014 to ADR-0017)

- One GraphQL endpoint, `/graphql`, built code-first with Pothos and served by GraphQL
  Yoga. `npm run schema` prints the contract to `schema.graphql`; commit it with the
  change that produced it (ADR-0016).
- Every request needs a Firebase ID token (`Authorization: Bearer <token>`) for an
  account in the `users` table; otherwise 401 or 403 (ADR-0015).
- CORS allows only `FRONTEND_ORIGIN`; requests are rate-limited per client IP.
- Only trusted documents run (`persisted/`). `GRAPHQL_ALLOW_ARBITRARY=true` lifts this
  for local development only.
- Operator fields `pipelineRuns` and `ingestLedger` need `users.is_operator`. Until the
  frontend exists, read `job_run` and `ingest_ledger` directly in MySQL.
- `GET /health` is a plain probe for the host, outside the API.

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
        nflverse.service.ts  HEAD for version, streamed CSV download
        load.service.ts      staging table -> swap in one transaction
        ingest.service.ts    one pipeline run (lock, ledger, per-piece load)
      graphql/               pipelineRuns, ingestLedger (operator accounts only)
  scheduler/index.ts         cron schedule that calls the ingest entry point
  jobs/                      CLI entry points: ingest, backfill, headers, spike
sql/                         hand-applied schema statements, in order
persisted/                   trusted documents
```

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
npm run build && npm start
```

## Mapping a dataset

1. `npm run headers -- --dataset stats_player_week` to see the columns.
2. Write the `CREATE TABLE` (ETL spec §7.2 and data dictionary) in a new
   `sql/000N_*.sql` file and apply it by hand.
3. Fill `table` and `columns` for that dataset in `datasets.ts`.
4. `npm run ingest -- --dataset stats_player_week`.

Datasets without a mapping are skipped and reported.

## Load rules

- One piece = one dataset file (dataset x season; season 0 for single files) (D5).
- A piece is skipped when its ETag matches the ledger's last successful load.
- Rows stream into `<table>__staging` in batches, then one transaction replaces the
  target rows (that season for history datasets; the whole table otherwise) and commits.
- `history` datasets keep 2022-current (ADR-0006); `current_season` datasets (play-by-play,
  depth charts) keep only the current season (ADR-0013); `single_file` datasets are
  replaced whole.
- Current season (D6): rosters switch to the new season on March 15; every other
  seasonal dataset on the Wednesday after Labor Day. `CURRENT_SEASON` overrides both.
- Empty strings and `NA` become NULL.
- Not built yet: the checks that block or warn on a load (ETL spec §8, D10).
