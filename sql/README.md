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
