-- Schema principles review (2026-11-24): owner decisions D1-D8 (consolidated 2026-11-25), schema migration.
-- Backend file sql/0015_schema_review.sql (kept identical to the planning copy next to the schema principles review).
-- Source of truth: design/reviews/2026-11-24-schema-principles-review.md section 5.1 and the
-- implementation plan section 6. Tested 2026-11-25 on MySQL 8.4 (empty schema built from sql/0001-0014,
-- plus a seeded sample covering every edge case); see the plan for the test record.
--
-- WHAT IT DOES (in order): creates source, player_source, game_source, stadium, position_group, position;
-- moves provider IDs and game facts into them; copies the few values only a
-- fact row holds onto player/game; deletes roster rows whose player is not in `player` (decision D5);
-- drops the descriptor, duplicate and provider-ID columns; adds every foreign key decided in D3.
--
-- BEFORE RUNNING
--   1. Stop the scheduler and every job (ALTER TABLE commits implicitly; a run mid-way would fail).
--   2. Take a backup (mysqldump of the schema). Steps 4 and 12 delete data: roster rows for unknown
--      players, and the dropped columns.
--   3. Includes backend sql/0014 as step 0; skip that step's ALTER if 0014 was already applied (it is harmless to re-run).
--   4. Deploy the backend code that matches this schema in the same window (implementation plan step 4):
--      the old column maps fail against the new tables.
--   5. Run in a UTC session: SET time_zone = '+00:00';
-- It is not idempotent: run it once. Each step reports counts into a temporary table shown at the end.

SET time_zone = '+00:00';
DROP TEMPORARY TABLE IF EXISTS migration_log;
CREATE TEMPORARY TABLE migration_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  step VARCHAR(160) NOT NULL,
  n BIGINT NULL
);

-- 0. job_run.outcome keeps only running, ok and failed (no run lock; ADR-0006). Same as backend sql/0014.
--    Stops here with an error, changing nothing, if a job_run row holds another value; the pre-check below shows them.
SELECT id, started_at, outcome FROM job_run WHERE outcome NOT IN ('running','ok','failed');
ALTER TABLE job_run
  MODIFY COLUMN outcome ENUM('running','ok','failed') NOT NULL DEFAULT 'running',
  MODIFY COLUMN kind ENUM('ingest','backfill','reconcile') NOT NULL;  -- reconcile: the quarterly reconciliation run (ADR-0028)

-- 1. source: one row per ID provider (D4). source_code is the key.
CREATE TABLE source (
  source_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_name VARCHAR(64) NOT NULL,
  PRIMARY KEY (source_code)
) ENGINE = InnoDB;
INSERT INTO source (source_code, source_name) VALUES
  ('pfr', 'Pro Football Reference'),
  ('espn', 'ESPN'),
  ('sleeper', 'Sleeper'),
  ('yahoo', 'Yahoo'),
  ('sportradar', 'Sportradar'),
  ('rotowire', 'RotoWire'),
  ('fantasy_data', 'FantasyData'),
  ('pff', 'Pro Football Focus'),
  ('otc', 'Over The Cap'),
  ('esb', 'Elias Sports Bureau'),
  ('smart', 'NFL Smart ID'),
  ('nfl', 'NFL ID (GSIS IT)'),
  ('gsis', 'NFL Game Statistics & Information System game ID'),
  ('nfl_detail', 'NFL Detail game ID'),
  ('nfl_old', 'NFL legacy game ID'),
  ('ftn', 'FTN'),
  ('nfl_api', 'NFL API game ID');

-- 2. player_source: a player's ID at one provider (D4). One ID per player per provider; an ID belongs to
--    one player. players.csv (the `player` table) wins; roster values fill only providers player lacks.
--    A value shared by two players within one column is skipped and counted, never stored.
CREATE TABLE player_source (
  gsis_id          VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_code      VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_player_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (gsis_id, source_code),
  UNIQUE KEY uq_player_source_id (source_code, source_player_id),
  CONSTRAINT fk_player_source_player FOREIGN KEY (gsis_id)     REFERENCES player (gsis_id) ON DELETE CASCADE,
  CONSTRAINT fk_player_source_source FOREIGN KEY (source_code) REFERENCES source (source_code) ON DELETE RESTRICT
) ENGINE = InnoDB;

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'esb', CONVERT(CAST(p.esb_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.esb_id IS NOT NULL
   AND p.esb_id NOT IN (SELECT d.esb_id FROM (SELECT esb_id FROM player WHERE esb_id IS NOT NULL
                                           GROUP BY esb_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.esb_id (esb)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.esb_id: value shared by two players', COUNT(*) FROM player
 WHERE esb_id IN (SELECT d.esb_id FROM (SELECT esb_id FROM player WHERE esb_id IS NOT NULL GROUP BY esb_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'nfl', CONVERT(CAST(p.nfl_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.nfl_id IS NOT NULL
   AND p.nfl_id NOT IN (SELECT d.nfl_id FROM (SELECT nfl_id FROM player WHERE nfl_id IS NOT NULL
                                           GROUP BY nfl_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.nfl_id (nfl)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.nfl_id: value shared by two players', COUNT(*) FROM player
 WHERE nfl_id IN (SELECT d.nfl_id FROM (SELECT nfl_id FROM player WHERE nfl_id IS NOT NULL GROUP BY nfl_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'pfr', CONVERT(CAST(p.pfr_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.pfr_id IS NOT NULL
   AND p.pfr_id NOT IN (SELECT d.pfr_id FROM (SELECT pfr_id FROM player WHERE pfr_id IS NOT NULL
                                           GROUP BY pfr_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.pfr_id (pfr)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.pfr_id: value shared by two players', COUNT(*) FROM player
 WHERE pfr_id IN (SELECT d.pfr_id FROM (SELECT pfr_id FROM player WHERE pfr_id IS NOT NULL GROUP BY pfr_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'pff', CONVERT(CAST(p.pff_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.pff_id IS NOT NULL
   AND p.pff_id NOT IN (SELECT d.pff_id FROM (SELECT pff_id FROM player WHERE pff_id IS NOT NULL
                                           GROUP BY pff_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.pff_id (pff)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.pff_id: value shared by two players', COUNT(*) FROM player
 WHERE pff_id IN (SELECT d.pff_id FROM (SELECT pff_id FROM player WHERE pff_id IS NOT NULL GROUP BY pff_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'otc', CONVERT(CAST(p.otc_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.otc_id IS NOT NULL
   AND p.otc_id NOT IN (SELECT d.otc_id FROM (SELECT otc_id FROM player WHERE otc_id IS NOT NULL
                                           GROUP BY otc_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.otc_id (otc)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.otc_id: value shared by two players', COUNT(*) FROM player
 WHERE otc_id IN (SELECT d.otc_id FROM (SELECT otc_id FROM player WHERE otc_id IS NOT NULL GROUP BY otc_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'espn', CONVERT(CAST(p.espn_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.espn_id IS NOT NULL
   AND p.espn_id NOT IN (SELECT d.espn_id FROM (SELECT espn_id FROM player WHERE espn_id IS NOT NULL
                                           GROUP BY espn_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.espn_id (espn)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.espn_id: value shared by two players', COUNT(*) FROM player
 WHERE espn_id IN (SELECT d.espn_id FROM (SELECT espn_id FROM player WHERE espn_id IS NOT NULL GROUP BY espn_id HAVING COUNT(*) > 1) d);

INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT p.gsis_id, 'smart', CONVERT(CAST(p.smart_id AS CHAR) USING ascii)
  FROM player p
 WHERE p.smart_id IS NOT NULL
   AND p.smart_id NOT IN (SELECT d.smart_id FROM (SELECT smart_id FROM player WHERE smart_id IS NOT NULL
                                           GROUP BY smart_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('player_source from player.smart_id (smart)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED player.smart_id: value shared by two players', COUNT(*) FROM player
 WHERE smart_id IN (SELECT d.smart_id FROM (SELECT smart_id FROM player WHERE smart_id IS NOT NULL GROUP BY smart_id HAVING COUNT(*) > 1) d);

-- roster.espn_id -> 'espn': the player's latest roster season; only if the player exists, has no 'espn' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'espn', CONVERT(CAST(r.espn_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE espn_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.espn_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'espn')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'espn' AND ps.source_player_id = CONVERT(CAST(r.espn_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.espn_id = r.espn_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.espn_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.espn_id (espn)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.espn_id: differs from the stored espn ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'espn'
 WHERE r.espn_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.espn_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.sportradar_id -> 'sportradar': the player's latest roster season; only if the player exists, has no 'sportradar' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'sportradar', CONVERT(CAST(r.sportradar_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE sportradar_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.sportradar_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'sportradar')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'sportradar' AND ps.source_player_id = CONVERT(CAST(r.sportradar_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.sportradar_id = r.sportradar_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.sportradar_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.sportradar_id (sportradar)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.sportradar_id: differs from the stored sportradar ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'sportradar'
 WHERE r.sportradar_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.sportradar_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.yahoo_id -> 'yahoo': the player's latest roster season; only if the player exists, has no 'yahoo' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'yahoo', CONVERT(CAST(r.yahoo_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE yahoo_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.yahoo_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'yahoo')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'yahoo' AND ps.source_player_id = CONVERT(CAST(r.yahoo_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.yahoo_id = r.yahoo_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.yahoo_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.yahoo_id (yahoo)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.yahoo_id: differs from the stored yahoo ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'yahoo'
 WHERE r.yahoo_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.yahoo_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.rotowire_id -> 'rotowire': the player's latest roster season; only if the player exists, has no 'rotowire' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'rotowire', CONVERT(CAST(r.rotowire_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE rotowire_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.rotowire_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'rotowire')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'rotowire' AND ps.source_player_id = CONVERT(CAST(r.rotowire_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.rotowire_id = r.rotowire_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.rotowire_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.rotowire_id (rotowire)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.rotowire_id: differs from the stored rotowire ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'rotowire'
 WHERE r.rotowire_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.rotowire_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.pff_id -> 'pff': the player's latest roster season; only if the player exists, has no 'pff' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'pff', CONVERT(CAST(r.pff_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE pff_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.pff_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'pff')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'pff' AND ps.source_player_id = CONVERT(CAST(r.pff_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.pff_id = r.pff_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.pff_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.pff_id (pff)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.pff_id: differs from the stored pff ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'pff'
 WHERE r.pff_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.pff_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.pfr_id -> 'pfr': the player's latest roster season; only if the player exists, has no 'pfr' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'pfr', CONVERT(CAST(r.pfr_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE pfr_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.pfr_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'pfr')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'pfr' AND ps.source_player_id = CONVERT(CAST(r.pfr_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.pfr_id = r.pfr_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.pfr_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.pfr_id (pfr)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.pfr_id: differs from the stored pfr ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'pfr'
 WHERE r.pfr_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.pfr_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.fantasy_data_id -> 'fantasy_data': the player's latest roster season; only if the player exists, has no 'fantasy_data' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'fantasy_data', CONVERT(CAST(r.fantasy_data_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE fantasy_data_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.fantasy_data_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'fantasy_data')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'fantasy_data' AND ps.source_player_id = CONVERT(CAST(r.fantasy_data_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.fantasy_data_id = r.fantasy_data_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.fantasy_data_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.fantasy_data_id (fantasy_data)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.fantasy_data_id: differs from the stored fantasy_data ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'fantasy_data'
 WHERE r.fantasy_data_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.fantasy_data_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.sleeper_id -> 'sleeper': the player's latest roster season; only if the player exists, has no 'sleeper' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'sleeper', CONVERT(CAST(r.sleeper_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE sleeper_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.sleeper_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'sleeper')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'sleeper' AND ps.source_player_id = CONVERT(CAST(r.sleeper_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.sleeper_id = r.sleeper_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.sleeper_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.sleeper_id (sleeper)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.sleeper_id: differs from the stored sleeper ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'sleeper'
 WHERE r.sleeper_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.sleeper_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.esb_id -> 'esb': the player's latest roster season; only if the player exists, has no 'esb' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'esb', CONVERT(CAST(r.esb_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE esb_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.esb_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'esb')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'esb' AND ps.source_player_id = CONVERT(CAST(r.esb_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.esb_id = r.esb_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.esb_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.esb_id (esb)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.esb_id: differs from the stored esb ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'esb'
 WHERE r.esb_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.esb_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.gsis_it_id -> 'nfl': the player's latest roster season; only if the player exists, has no 'nfl' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'nfl', CONVERT(CAST(r.gsis_it_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE gsis_it_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.gsis_it_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'nfl')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'nfl' AND ps.source_player_id = CONVERT(CAST(r.gsis_it_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.gsis_it_id = r.gsis_it_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.gsis_it_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.gsis_it_id (nfl)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.gsis_it_id: differs from the stored nfl ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'nfl'
 WHERE r.gsis_it_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.gsis_it_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- roster.smart_id -> 'smart': the player's latest roster season; only if the player exists, has no 'smart' ID
-- yet, and no other player already holds (or, on the roster, shares) the value.
INSERT INTO player_source (gsis_id, source_code, source_player_id)
SELECT r.gsis_id, 'smart', CONVERT(CAST(r.smart_id AS CHAR) USING ascii) COLLATE ascii_bin
  FROM roster r
  JOIN (SELECT gsis_id, MAX(season) AS season FROM roster WHERE smart_id IS NOT NULL GROUP BY gsis_id) latest
    ON latest.gsis_id = r.gsis_id AND latest.season = r.season
  JOIN player p ON p.gsis_id = r.gsis_id
 WHERE r.smart_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.gsis_id = r.gsis_id AND ps.source_code = 'smart')
   AND NOT EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'smart' AND ps.source_player_id = CONVERT(CAST(r.smart_id AS CHAR) USING ascii) COLLATE ascii_bin)
   AND NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.smart_id = r.smart_id AND r2.gsis_id <> r.gsis_id)
 GROUP BY r.gsis_id, CONVERT(CAST(r.smart_id AS CHAR) USING ascii) COLLATE ascii_bin;
INSERT INTO migration_log (step, n) VALUES ('player_source from roster.smart_id (smart)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'LOGGED roster.smart_id: differs from the stored smart ID (players.csv wins)', COUNT(DISTINCT r.gsis_id)
  FROM roster r JOIN player_source ps ON ps.gsis_id = r.gsis_id AND ps.source_code = 'smart'
 WHERE r.smart_id IS NOT NULL AND ps.source_player_id <> CONVERT(CAST(r.smart_id AS CHAR) USING ascii) COLLATE ascii_bin;

-- 3. Copy values that only a fact row holds onto player, before those columns are dropped (D7).
UPDATE player p
  JOIN (SELECT s.player_id, MAX(s.player_name) AS player_name FROM player_week_stat s
         WHERE s.player_name IS NOT NULL GROUP BY s.player_id) x ON x.player_id = p.gsis_id
   SET p.short_name = x.player_name
 WHERE p.short_name IS NULL;
INSERT INTO migration_log (step, n) VALUES ('player.short_name filled from player_week_stat.player_name', ROW_COUNT());
UPDATE player p
  JOIN (SELECT r.gsis_id, r.first_name, r.last_name, r.football_name, r.birth_date, r.college
          FROM roster r
          JOIN (SELECT gsis_id, MAX(season) AS season FROM roster GROUP BY gsis_id) l
            ON l.gsis_id = r.gsis_id AND l.season = r.season
         GROUP BY r.gsis_id, r.first_name, r.last_name, r.football_name, r.birth_date, r.college) x
    ON x.gsis_id = p.gsis_id
   SET p.first_name    = COALESCE(p.first_name, x.first_name),
       p.last_name     = COALESCE(p.last_name, x.last_name),
       p.football_name = COALESCE(p.football_name, x.football_name),
       p.birth_date    = COALESCE(p.birth_date, x.birth_date),
       p.college_name  = COALESCE(p.college_name, x.college)
 WHERE p.first_name IS NULL OR p.last_name IS NULL OR p.football_name IS NULL
    OR p.birth_date IS NULL OR p.college_name IS NULL;
INSERT INTO migration_log (step, n) VALUES ('player name/birth date/college filled from roster', ROW_COUNT());

-- 4. Roster rows whose player is not in `player` are excluded (D5). DELETES DATA (858 rows on 2026-11-25).
DELETE r FROM roster r LEFT JOIN player p ON p.gsis_id = r.gsis_id WHERE p.gsis_id IS NULL;
INSERT INTO migration_log (step, n) VALUES ('DELETED roster rows for players missing from player', ROW_COUNT());

-- 5. game_source: a game's ID at another provider (D4). An ID shared by two games is skipped and counted.
CREATE TABLE game_source (
  game_id        VARCHAR(32) CHARACTER SET ascii NOT NULL,
  source_code    VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_game_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (game_id, source_code),
  UNIQUE KEY uq_game_source_id (source_code, source_game_id),
  CONSTRAINT fk_game_source_game   FOREIGN KEY (game_id)     REFERENCES game (game_id) ON DELETE CASCADE,
  CONSTRAINT fk_game_source_source FOREIGN KEY (source_code) REFERENCES source (source_code) ON DELETE RESTRICT
) ENGINE = InnoDB;

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'nfl_old', CONVERT(CAST(g.old_game_id AS CHAR) USING ascii)
  FROM game g
 WHERE g.old_game_id IS NOT NULL
   AND g.old_game_id NOT IN (SELECT d.old_game_id FROM (SELECT old_game_id FROM game WHERE old_game_id IS NOT NULL GROUP BY old_game_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.old_game_id (nfl_old)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.old_game_id: value shared by two games', COUNT(*) FROM game
 WHERE old_game_id IN (SELECT d.old_game_id FROM (SELECT old_game_id FROM game WHERE old_game_id IS NOT NULL GROUP BY old_game_id HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'gsis', CONVERT(CAST(g.gsis AS CHAR) USING ascii)
  FROM game g
 WHERE g.gsis IS NOT NULL
   AND g.gsis NOT IN (SELECT d.gsis FROM (SELECT gsis FROM game WHERE gsis IS NOT NULL GROUP BY gsis HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.gsis (gsis)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.gsis: value shared by two games', COUNT(*) FROM game
 WHERE gsis IN (SELECT d.gsis FROM (SELECT gsis FROM game WHERE gsis IS NOT NULL GROUP BY gsis HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'nfl_detail', CONVERT(CAST(g.nfl_detail_id AS CHAR) USING ascii)
  FROM game g
 WHERE g.nfl_detail_id IS NOT NULL
   AND g.nfl_detail_id NOT IN (SELECT d.nfl_detail_id FROM (SELECT nfl_detail_id FROM game WHERE nfl_detail_id IS NOT NULL GROUP BY nfl_detail_id HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.nfl_detail_id (nfl_detail)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.nfl_detail_id: value shared by two games', COUNT(*) FROM game
 WHERE nfl_detail_id IN (SELECT d.nfl_detail_id FROM (SELECT nfl_detail_id FROM game WHERE nfl_detail_id IS NOT NULL GROUP BY nfl_detail_id HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'pfr', CONVERT(CAST(g.pfr AS CHAR) USING ascii)
  FROM game g
 WHERE g.pfr IS NOT NULL
   AND g.pfr NOT IN (SELECT d.pfr FROM (SELECT pfr FROM game WHERE pfr IS NOT NULL GROUP BY pfr HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.pfr (pfr)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.pfr: value shared by two games', COUNT(*) FROM game
 WHERE pfr IN (SELECT d.pfr FROM (SELECT pfr FROM game WHERE pfr IS NOT NULL GROUP BY pfr HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'pff', CONVERT(CAST(g.pff AS CHAR) USING ascii)
  FROM game g
 WHERE g.pff IS NOT NULL
   AND g.pff NOT IN (SELECT d.pff FROM (SELECT pff FROM game WHERE pff IS NOT NULL GROUP BY pff HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.pff (pff)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.pff: value shared by two games', COUNT(*) FROM game
 WHERE pff IN (SELECT d.pff FROM (SELECT pff FROM game WHERE pff IS NOT NULL GROUP BY pff HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'espn', CONVERT(CAST(g.espn AS CHAR) USING ascii)
  FROM game g
 WHERE g.espn IS NOT NULL
   AND g.espn NOT IN (SELECT d.espn FROM (SELECT espn FROM game WHERE espn IS NOT NULL GROUP BY espn HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.espn (espn)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.espn: value shared by two games', COUNT(*) FROM game
 WHERE espn IN (SELECT d.espn FROM (SELECT espn FROM game WHERE espn IS NOT NULL GROUP BY espn HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT g.game_id, 'ftn', CONVERT(CAST(g.ftn AS CHAR) USING ascii)
  FROM game g
 WHERE g.ftn IS NOT NULL
   AND g.ftn NOT IN (SELECT d.ftn FROM (SELECT ftn FROM game WHERE ftn IS NOT NULL GROUP BY ftn HAVING COUNT(*) > 1) d);
INSERT INTO migration_log (step, n) VALUES ('game_source from game.ftn (ftn)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'SKIPPED game.ftn: value shared by two games', COUNT(*) FROM game
 WHERE ftn IN (SELECT d.ftn FROM (SELECT ftn FROM game WHERE ftn IS NOT NULL GROUP BY ftn HAVING COUNT(*) > 1) d);

INSERT INTO game_source (game_id, source_code, source_game_id)
SELECT x.game_id, 'nfl_api', x.nfl_api_id
  FROM (SELECT game_id, MAX(nfl_api_id) AS nfl_api_id FROM play WHERE nfl_api_id IS NOT NULL GROUP BY game_id) x
  JOIN game g ON g.game_id = x.game_id
 WHERE x.nfl_api_id NOT IN (SELECT d.v FROM (SELECT MAX(nfl_api_id) AS v FROM play WHERE nfl_api_id IS NOT NULL
                                             GROUP BY game_id) d GROUP BY d.v HAVING COUNT(*) > 1);
INSERT INTO migration_log (step, n) VALUES ('game_source from play.nfl_api_id (nfl_api)', ROW_COUNT());

-- 6. Game facts that only play-by-play holds move to game (D7); game.stadium takes play-by-play's name,
--    which is current where games.csv's is outdated (58 of 285 games in 2025).
ALTER TABLE game
  ADD COLUMN start_time           VARCHAR(32)  NULL AFTER gametime,
  ADD COLUMN weather              VARCHAR(128) NULL AFTER wind,
  ADD COLUMN home_opening_kickoff BOOLEAN      NULL AFTER weather;
UPDATE game g
  JOIN (SELECT game_id, MAX(start_time) AS start_time, MAX(weather) AS weather,
               MAX(home_opening_kickoff) AS home_opening_kickoff, MAX(stadium) AS stadium
          FROM play GROUP BY game_id) x ON x.game_id = g.game_id
   SET g.start_time = x.start_time, g.weather = x.weather,
       g.home_opening_kickoff = x.home_opening_kickoff,
       g.stadium = COALESCE(x.stadium, g.stadium);
INSERT INTO migration_log (step, n) VALUES ('game rows given start_time/weather/home_opening_kickoff/stadium from play', ROW_COUNT());

-- 7. stadium: one row per stadium_id, holding the name it carries in its most recent season (D6).
CREATE TABLE stadium (
  stadium_id   VARCHAR(8)  CHARACTER SET ascii NOT NULL,
  stadium_name VARCHAR(64) NOT NULL,
  PRIMARY KEY (stadium_id)
) ENGINE = InnoDB;
INSERT INTO stadium (stadium_id, stadium_name)
SELECT stadium_id, stadium
  FROM (SELECT stadium_id, stadium,
               ROW_NUMBER() OVER (PARTITION BY stadium_id ORDER BY season DESC, COUNT(*) DESC, stadium) AS rn
          FROM game WHERE stadium_id IS NOT NULL AND stadium IS NOT NULL
         GROUP BY stadium_id, season, stadium) t
 WHERE rn = 1;
INSERT INTO migration_log (step, n) VALUES ('stadium rows', ROW_COUNT());

-- 8. Depth-chart lookups (D6): position_group and position, from the rows already loaded.
CREATE TABLE position_group (
  pos_grp_id INT UNSIGNED NOT NULL,
  pos_grp    VARCHAR(32)  NOT NULL,
  PRIMARY KEY (pos_grp_id)
) ENGINE = InnoDB;
INSERT INTO position_group (pos_grp_id, pos_grp)
SELECT pos_grp_id, MAX(pos_grp) FROM depth_chart WHERE pos_grp IS NOT NULL GROUP BY pos_grp_id;
INSERT INTO migration_log (step, n) VALUES ('position_group rows', ROW_COUNT());
CREATE TABLE position (
  pos_id   INT UNSIGNED NOT NULL,
  pos_name VARCHAR(32)  NOT NULL,
  pos_abb  VARCHAR(8)   NOT NULL,
  PRIMARY KEY (pos_id)
) ENGINE = InnoDB;
INSERT INTO position (pos_id, pos_name, pos_abb)
SELECT pos_id, MAX(pos_name), MAX(pos_abb) FROM depth_chart
 WHERE pos_id IS NOT NULL AND pos_name IS NOT NULL AND pos_abb IS NOT NULL GROUP BY pos_id;
INSERT INTO migration_log (step, n) VALUES ('position rows', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'CHECK pos_grp_id with more than one name (expect 0)', COUNT(*) FROM
  (SELECT pos_grp_id FROM depth_chart GROUP BY pos_grp_id HAVING COUNT(DISTINCT pos_grp) > 1) t;
INSERT INTO migration_log (step, n)
SELECT 'CHECK pos_id with more than one name (expect 0)', COUNT(*) FROM
  (SELECT pos_id FROM depth_chart WHERE pos_id IS NOT NULL GROUP BY pos_id HAVING COUNT(DISTINCT pos_name, pos_abb) > 1) t;

-- 9. depth_chart rows with no gsis_id: fill it by exact ESPN ID through player_source (D5).
UPDATE depth_chart d
  JOIN player_source ps ON ps.source_code = 'espn' AND ps.source_player_id = CONVERT(CAST(d.espn_id AS CHAR) USING ascii) COLLATE ascii_bin
   SET d.gsis_id = ps.gsis_id
 WHERE d.gsis_id IS NULL AND d.espn_id IS NOT NULL;
INSERT INTO migration_log (step, n) VALUES ('depth_chart gsis_id filled from espn_id', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'depth_chart rows still without gsis_id (loaded, counted: D5)', COUNT(*) FROM depth_chart WHERE gsis_id IS NULL;

-- 10. snap_count keeps the PFR ID; source_code = 'pfr' where player_source knows it, else NULL (D4, D5).
ALTER TABLE snap_count
  ADD COLUMN source_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER pfr_player_id;
UPDATE snap_count s
   SET s.source_code = 'pfr'
 WHERE EXISTS (SELECT 1 FROM player_source ps WHERE ps.source_code = 'pfr' AND ps.source_player_id = s.pfr_player_id);
INSERT INTO migration_log (step, n) VALUES ('snap_count rows linked to a player (source_code = pfr)', ROW_COUNT());
INSERT INTO migration_log (step, n)
SELECT 'snap_count rows with an unknown PFR ID (loaded, counted: D5)', COUNT(*) FROM snap_count WHERE source_code IS NULL;

-- 11. Drop moved, descriptor and duplicate columns (D4, D6, D7). Also drops the foreign keys on play's 14 numbered
--     slot team columns (the columns stay): MySQL allows 64 indexes per table, and play needs 55 without them (D8). Foreign keys on dropped columns go first.
ALTER TABLE play
  DROP FOREIGN KEY fk_play_assist_tackle_1_team,
  DROP FOREIGN KEY fk_play_assist_tackle_2_team,
  DROP FOREIGN KEY fk_play_assist_tackle_3_team,
  DROP FOREIGN KEY fk_play_assist_tackle_4_team,
  DROP FOREIGN KEY fk_play_solo_tackle_1_team,
  DROP FOREIGN KEY fk_play_solo_tackle_2_team,
  DROP FOREIGN KEY fk_play_tackle_with_assist_1_team,
  DROP FOREIGN KEY fk_play_tackle_with_assist_2_team,
  DROP FOREIGN KEY fk_play_forced_fumble_1_team,
  DROP FOREIGN KEY fk_play_forced_fumble_2_team,
  DROP FOREIGN KEY fk_play_fumbled_1_team,
  DROP FOREIGN KEY fk_play_fumbled_2_team,
  DROP FOREIGN KEY fk_play_fumble_recovery_1_team,
  DROP FOREIGN KEY fk_play_fumble_recovery_2_team,
  DROP FOREIGN KEY fk_play_home_team,
  DROP FOREIGN KEY fk_play_away_team;
-- Dropping a foreign key keeps its index; the 14 slot-team indexes are dropped too, or they still count toward 64.
ALTER TABLE play
  DROP INDEX fk_play_assist_tackle_1_team,
  DROP INDEX fk_play_assist_tackle_2_team,
  DROP INDEX fk_play_assist_tackle_3_team,
  DROP INDEX fk_play_assist_tackle_4_team,
  DROP INDEX fk_play_solo_tackle_1_team,
  DROP INDEX fk_play_solo_tackle_2_team,
  DROP INDEX fk_play_tackle_with_assist_1_team,
  DROP INDEX fk_play_tackle_with_assist_2_team,
  DROP INDEX fk_play_forced_fumble_1_team,
  DROP INDEX fk_play_forced_fumble_2_team,
  DROP INDEX fk_play_fumbled_1_team,
  DROP INDEX fk_play_fumbled_2_team,
  DROP INDEX fk_play_fumble_recovery_1_team,
  DROP INDEX fk_play_fumble_recovery_2_team;
ALTER TABLE player
  DROP COLUMN esb_id,
  DROP COLUMN nfl_id,
  DROP COLUMN pfr_id,
  DROP COLUMN pff_id,
  DROP COLUMN otc_id,
  DROP COLUMN espn_id,
  DROP COLUMN smart_id;
ALTER TABLE roster
  DROP COLUMN full_name,
  DROP COLUMN first_name,
  DROP COLUMN last_name,
  DROP COLUMN football_name,
  DROP COLUMN birth_date,
  DROP COLUMN college,
  DROP COLUMN rookie_year,
  DROP COLUMN entry_year,
  DROP COLUMN draft_number,
  DROP COLUMN draft_club,
  DROP COLUMN espn_id,
  DROP COLUMN sportradar_id,
  DROP COLUMN yahoo_id,
  DROP COLUMN rotowire_id,
  DROP COLUMN pff_id,
  DROP COLUMN pfr_id,
  DROP COLUMN fantasy_data_id,
  DROP COLUMN sleeper_id,
  DROP COLUMN esb_id,
  DROP COLUMN gsis_it_id,
  DROP COLUMN smart_id;
ALTER TABLE game
  DROP COLUMN away_qb_name,
  DROP COLUMN home_qb_name,
  DROP COLUMN old_game_id,
  DROP COLUMN gsis,
  DROP COLUMN nfl_detail_id,
  DROP COLUMN pfr,
  DROP COLUMN pff,
  DROP COLUMN espn,
  DROP COLUMN ftn;
ALTER TABLE player_week_stat
  DROP COLUMN player_name,
  DROP COLUMN player_display_name,
  DROP COLUMN headshot_url;
ALTER TABLE injury_report
  DROP COLUMN full_name,
  DROP COLUMN first_name,
  DROP COLUMN last_name;
ALTER TABLE snap_count
  DROP COLUMN pfr_game_id,
  DROP COLUMN season,
  DROP COLUMN week,
  DROP COLUMN game_type;
ALTER TABLE depth_chart
  DROP COLUMN pos_grp,
  DROP COLUMN pos_name,
  DROP COLUMN pos_abb;
ALTER TABLE play
  DROP COLUMN old_game_id,
  DROP COLUMN home_team,
  DROP COLUMN away_team,
  DROP COLUMN season,
  DROP COLUMN week,
  DROP COLUMN game_date,
  DROP COLUMN game_stadium,
  DROP COLUMN stadium_id,
  DROP COLUMN roof,
  DROP COLUMN surface,
  DROP COLUMN temp,
  DROP COLUMN wind,
  DROP COLUMN home_coach,
  DROP COLUMN away_coach,
  DROP COLUMN away_score,
  DROP COLUMN home_score,
  DROP COLUMN location,
  DROP COLUMN result,
  DROP COLUMN total,
  DROP COLUMN spread_line,
  DROP COLUMN total_line,
  DROP COLUMN div_game,
  DROP COLUMN season_type,
  DROP COLUMN start_time,
  DROP COLUMN weather,
  DROP COLUMN home_opening_kickoff,
  DROP COLUMN stadium,
  DROP COLUMN nfl_api_id,
  DROP COLUMN assist_tackle_1_player_name,
  DROP COLUMN assist_tackle_2_player_name,
  DROP COLUMN assist_tackle_3_player_name,
  DROP COLUMN assist_tackle_4_player_name,
  DROP COLUMN solo_tackle_1_player_name,
  DROP COLUMN solo_tackle_2_player_name,
  DROP COLUMN tackle_with_assist_1_player_name,
  DROP COLUMN tackle_with_assist_2_player_name,
  DROP COLUMN forced_fumble_player_1_player_name,
  DROP COLUMN forced_fumble_player_2_player_name,
  DROP COLUMN fumbled_1_player_name,
  DROP COLUMN fumbled_2_player_name,
  DROP COLUMN fumble_recovery_1_player_name,
  DROP COLUMN fumble_recovery_2_player_name,
  DROP COLUMN tackle_for_loss_1_player_name,
  DROP COLUMN tackle_for_loss_2_player_name,
  DROP COLUMN qb_hit_1_player_name,
  DROP COLUMN qb_hit_2_player_name,
  DROP COLUMN pass_defense_1_player_name,
  DROP COLUMN pass_defense_2_player_name,
  DROP COLUMN half_sack_1_player_name,
  DROP COLUMN half_sack_2_player_name,
  DROP COLUMN td_player_name,
  DROP COLUMN passer_player_name,
  DROP COLUMN receiver_player_name,
  DROP COLUMN rusher_player_name,
  DROP COLUMN lateral_receiver_player_name,
  DROP COLUMN lateral_rusher_player_name,
  DROP COLUMN lateral_sack_player_name,
  DROP COLUMN interception_player_name,
  DROP COLUMN lateral_interception_player_name,
  DROP COLUMN punt_returner_player_name,
  DROP COLUMN lateral_punt_returner_player_name,
  DROP COLUMN kickoff_returner_player_name,
  DROP COLUMN lateral_kickoff_returner_player_name,
  DROP COLUMN punter_player_name,
  DROP COLUMN kicker_player_name,
  DROP COLUMN own_kickoff_recovery_player_name,
  DROP COLUMN blocked_player_name,
  DROP COLUMN sack_player_name,
  DROP COLUMN penalty_player_name,
  DROP COLUMN safety_player_name,
  DROP COLUMN fantasy_player_name,
  DROP COLUMN passer,
  DROP COLUMN rusher,
  DROP COLUMN receiver,
  DROP COLUMN fantasy,
  DROP COLUMN `name`;
INSERT INTO migration_log (step, n) VALUES ('columns dropped', 126);

-- 12. Foreign keys on every player and game reference (D3), including play's 22 numbered player-ID columns (D8), and on the new lookups (D6).
ALTER TABLE game
  ADD CONSTRAINT fk_game_away_qb FOREIGN KEY (away_qb_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_game_home_qb FOREIGN KEY (home_qb_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_game_stadium FOREIGN KEY (stadium_id) REFERENCES stadium (stadium_id);
ALTER TABLE player_week_stat
  ADD CONSTRAINT fk_player_week_stat_player FOREIGN KEY (player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_player_week_stat_game FOREIGN KEY (game_id) REFERENCES game (game_id);
ALTER TABLE team_week_stat
  ADD CONSTRAINT fk_team_week_stat_game FOREIGN KEY (game_id) REFERENCES game (game_id);
ALTER TABLE roster
  ADD CONSTRAINT fk_roster_player FOREIGN KEY (gsis_id) REFERENCES player (gsis_id);
ALTER TABLE injury_report
  ADD CONSTRAINT fk_injury_report_player FOREIGN KEY (gsis_id) REFERENCES player (gsis_id);
ALTER TABLE snap_count
  ADD CONSTRAINT fk_snap_count_game FOREIGN KEY (game_id) REFERENCES game (game_id),
  ADD CONSTRAINT fk_snap_count_player FOREIGN KEY (source_code, pfr_player_id) REFERENCES player_source (source_code, source_player_id);
ALTER TABLE depth_chart
  ADD CONSTRAINT fk_depth_chart_player FOREIGN KEY (gsis_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_depth_chart_position_group FOREIGN KEY (pos_grp_id) REFERENCES position_group (pos_grp_id),
  ADD CONSTRAINT fk_depth_chart_position FOREIGN KEY (pos_id) REFERENCES position (pos_id);
ALTER TABLE play
  ADD CONSTRAINT fk_play_game FOREIGN KEY (game_id) REFERENCES game (game_id),
  ADD CONSTRAINT fk_play_td_player_id FOREIGN KEY (td_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_passer_player_id FOREIGN KEY (passer_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_receiver_player_id FOREIGN KEY (receiver_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_rusher_player_id FOREIGN KEY (rusher_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_receiver_player_id FOREIGN KEY (lateral_receiver_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_rusher_player_id FOREIGN KEY (lateral_rusher_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_sack_player_id FOREIGN KEY (lateral_sack_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_interception_player_id FOREIGN KEY (interception_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_interception_player_id FOREIGN KEY (lateral_interception_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_punt_returner_player_id FOREIGN KEY (punt_returner_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_punt_returner_player_id FOREIGN KEY (lateral_punt_returner_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_kickoff_returner_player_id FOREIGN KEY (kickoff_returner_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_lateral_kickoff_returner_player_id FOREIGN KEY (lateral_kickoff_returner_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_punter_player_id FOREIGN KEY (punter_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_kicker_player_id FOREIGN KEY (kicker_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_own_kickoff_recovery_player_id FOREIGN KEY (own_kickoff_recovery_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_blocked_player_id FOREIGN KEY (blocked_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_sack_player_id FOREIGN KEY (sack_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_penalty_player_id FOREIGN KEY (penalty_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_safety_player_id FOREIGN KEY (safety_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fantasy_player_id FOREIGN KEY (fantasy_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_passer_id FOREIGN KEY (passer_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_rusher_id FOREIGN KEY (rusher_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_receiver_id FOREIGN KEY (receiver_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fantasy_id FOREIGN KEY (fantasy_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_id_player FOREIGN KEY (`id`) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_assist_tackle_1_player FOREIGN KEY (assist_tackle_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_assist_tackle_2_player FOREIGN KEY (assist_tackle_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_assist_tackle_3_player FOREIGN KEY (assist_tackle_3_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_assist_tackle_4_player FOREIGN KEY (assist_tackle_4_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_solo_tackle_1_player FOREIGN KEY (solo_tackle_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_solo_tackle_2_player FOREIGN KEY (solo_tackle_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_tackle_with_assist_1_player FOREIGN KEY (tackle_with_assist_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_tackle_with_assist_2_player FOREIGN KEY (tackle_with_assist_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_forced_fumble_player_1_player FOREIGN KEY (forced_fumble_player_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_forced_fumble_player_2_player FOREIGN KEY (forced_fumble_player_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fumbled_1_player FOREIGN KEY (fumbled_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fumbled_2_player FOREIGN KEY (fumbled_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fumble_recovery_1_player FOREIGN KEY (fumble_recovery_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_fumble_recovery_2_player FOREIGN KEY (fumble_recovery_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_tackle_for_loss_1_player FOREIGN KEY (tackle_for_loss_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_tackle_for_loss_2_player FOREIGN KEY (tackle_for_loss_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_qb_hit_1_player FOREIGN KEY (qb_hit_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_qb_hit_2_player FOREIGN KEY (qb_hit_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_pass_defense_1_player FOREIGN KEY (pass_defense_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_pass_defense_2_player FOREIGN KEY (pass_defense_2_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_half_sack_1_player FOREIGN KEY (half_sack_1_player_id) REFERENCES player (gsis_id),
  ADD CONSTRAINT fk_play_half_sack_2_player FOREIGN KEY (half_sack_2_player_id) REFERENCES player (gsis_id);
INSERT INTO migration_log (step, n) VALUES ('foreign keys added', 62);

-- 13. Row timestamps on every table (ADR-0029): set by the database, UTC because this session is UTC.
--     Existing rows get this migration's time as created_at ("present when the columns were added").
ALTER TABLE team
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE player
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE game
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE player_week_stat
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE team_week_stat
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE roster
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE injury_report
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE snap_count
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE depth_chart
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE play
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE source
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE player_source
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE game_source
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE stadium
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE position_group
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE position
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE ingest_ledger
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE job_run
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE users
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
INSERT INTO migration_log (step, n) VALUES ('tables given created_at/updated_at', 19);

-- Result: one grid of counts. SKIPPED/LOGGED rows are values not stored (D4); DELETED is D5's roster exclusion.
SELECT step, n FROM migration_log ORDER BY id;
