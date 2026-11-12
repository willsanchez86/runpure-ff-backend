# Schema statements

Schema changes are applied by hand (ADR-0011): run each file in numeric order against
each database copy (local now, hosted later), for example in MySQL Workbench. Every
statement that has been run is kept here so the schema can be rebuilt.

Data tables for each nflverse dataset are created here too, by hand, once their
columns are mapped (see `src/modules/pipeline/service/datasets.ts` and the ETL spec's
§7.2 and data dictionary).

Timestamps are stored as `DATETIME` in UTC (ETL spec §7.2.2).
