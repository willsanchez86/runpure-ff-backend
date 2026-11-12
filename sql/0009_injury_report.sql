-- injury_report fact (event): one player's report for one game week (ETL spec §7.2.1, data dictionary A7).
-- The latest report wins; the load keeps the newest date_modified for a repeated key (§7.2.3, §8).
-- The file has two headers (§7.2): 2017–2024 carries date_modified; 2025 on carries season_type and
-- drops date_modified, so both columns are nullable. team carries a foreign key to team; gsis_id is a
-- player reference with none (§7.2). Apply by hand (ADR-0011). Timestamps UTC; types follow §7.2.2.

CREATE TABLE IF NOT EXISTS injury_report (
  season                    SMALLINT UNSIGNED NOT NULL,
  game_type                 ENUM('CON','DIV','REG','SB','WC') NOT NULL,
  team                      VARCHAR(4) CHARACTER SET ascii NOT NULL,
  week                      TINYINT UNSIGNED NOT NULL,
  gsis_id                   VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position                  VARCHAR(8) CHARACTER SET ascii NOT NULL,
  full_name                 VARCHAR(64)  NOT NULL,
  first_name                VARCHAR(32)  NOT NULL,
  last_name                 VARCHAR(32)  NOT NULL,
  report_primary_injury     VARCHAR(255) NULL,
  report_secondary_injury   VARCHAR(128) NULL,
  report_status             VARCHAR(16)  NULL,
  practice_primary_injury   VARCHAR(128) NULL,
  practice_secondary_injury VARCHAR(64)  NULL,
  practice_status           VARCHAR(64)  NULL,
  date_modified             DATETIME     NULL,
  season_type               ENUM('POST','REG') NULL,
  PRIMARY KEY (season, week, game_type, team, gsis_id),
  CONSTRAINT fk_injury_report_team FOREIGN KEY (team) REFERENCES team (team_abbr)
) ENGINE = InnoDB;
