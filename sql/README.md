# Schema statements

Schema changes are applied by hand (ADR-0011): run each file in numeric order against
each database copy (local now, hosted later), for example in MySQL Workbench. Every
statement that has been run is kept here so the schema can be rebuilt.

Data tables for each nflverse dataset are created here too, by hand, once their
columns are mapped (see `src/modules/pipeline/service/datasets.ts` and the ETL spec's
§7.2 and data dictionary).

Changing a table that already exists: editing its `CREATE TABLE` here does not alter a
table already in a database, since `CREATE TABLE` only builds it on a fresh copy. For a
table with no data yet, drop it and re-run the edited file. For a table holding data,
write and apply the matching `ALTER TABLE` by hand, and update the `CREATE TABLE` here to
the new shape so a from-scratch rebuild still matches. Keep the change in step with the
mapping in `datasets.ts` and the data dictionary.

Timestamps are stored as `DATETIME` in UTC (ETL spec §7.2.2).

## File order

Run every file, in numeric order, on each database copy. `0001`-`0013` create the pipeline, user
and data tables. `0014` narrows `job_run.outcome`. `0015_schema_review.sql` reshapes the schema
to the decisions of the schema principles review (ADR-0022 to ADR-0029): it adds `source`,
`player_source`, `game_source`, `stadium`, `position_group` and `position`; moves provider IDs
and game facts into them; drops descriptor and duplicate columns; adds the foreign keys and the
`created_at`/`updated_at` columns. It also repeats `0014`'s change, so it is safe after `0014`.

`0015` works on an empty schema and on one that already holds data. On a database with data, stop
the server first and take a backup: it deletes roster rows whose player is not in `player` and
drops columns. Earlier files are left as they were first run, so a fresh rebuild is `0001` to
`0015` in order.
