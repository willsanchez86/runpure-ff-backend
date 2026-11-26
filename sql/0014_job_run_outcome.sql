-- job_run.outcome keeps only running, ok and failed (ADR-0006). Apply by hand (ADR-0011).
--
-- The ALTER fails, changing nothing, if any row holds another value. Check first:
--   SELECT id, started_at, outcome FROM job_run WHERE outcome NOT IN ('running','ok','failed');
-- If that returns rows, decide what to do with them before applying this file.
ALTER TABLE job_run
  MODIFY COLUMN outcome ENUM('running','ok','failed') NOT NULL DEFAULT 'running';
