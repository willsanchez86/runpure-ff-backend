-- Pipeline bookkeeping (ADR-0006, ADR-0005). Apply by hand (ADR-0011).
-- Timestamps are DATETIME in UTC.

CREATE TABLE IF NOT EXISTS ingest_ledger (
  id                   INT UNSIGNED      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dataset              VARCHAR(64)       NOT NULL,
  season               SMALLINT UNSIGNED NOT NULL COMMENT '0 for single-file datasets',
  source_url           VARCHAR(512)      NOT NULL,
  source_etag          VARCHAR(128)      NULL,
  source_last_modified VARCHAR(64)       NULL,
  content_length       BIGINT UNSIGNED   NULL,
  status               ENUM('downloading','loaded','failed') NOT NULL,
  rows_loaded          INT UNSIGNED      NULL,
  error                TEXT              NULL,
  started_at           DATETIME          NOT NULL,
  finished_at          DATETIME          NULL,
  UNIQUE KEY uq_ingest_ledger (dataset, season)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS job_run (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind           ENUM('ingest','backfill') NOT NULL,
  started_at     DATETIME     NOT NULL,
  finished_at    DATETIME     NULL,
  outcome        ENUM('running','ok','failed','skipped_locked') NOT NULL DEFAULT 'running',
  pieces_loaded  INT UNSIGNED NOT NULL DEFAULT 0,
  pieces_skipped INT UNSIGNED NOT NULL DEFAULT 0,
  pieces_failed  INT UNSIGNED NOT NULL DEFAULT 0,
  error          TEXT         NULL
) ENGINE = InnoDB;
