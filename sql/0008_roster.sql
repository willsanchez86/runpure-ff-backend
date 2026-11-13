-- roster fact (membership): one player on one team in one season (ETL spec §7.2.1, data dictionary A6).
-- team carries a foreign key to team; draft_club has none — nflverse uses a different team-code
-- vocabulary there (e.g. AZ for Arizona vs team_abbr ARI), so it can't reference team. gsis_id and
-- pfr_id are player references with none (§7.2). Rows with no player ID are dropped by the load, so
-- gsis_id is NOT NULL (§8). Non-key columns are nullable; keys are NOT NULL. Apply by hand (ADR-0011).

CREATE TABLE IF NOT EXISTS roster (
  season                  SMALLINT UNSIGNED NOT NULL,
  team                    VARCHAR(4) CHARACTER SET ascii NOT NULL,
  position                VARCHAR(4) CHARACTER SET ascii NULL,
  depth_chart_position    VARCHAR(4)   NULL,
  jersey_number           TINYINT UNSIGNED NULL,
  status                  VARCHAR(4) CHARACTER SET ascii NULL,
  full_name               VARCHAR(64)  NULL,
  first_name              VARCHAR(32)  NULL,
  last_name               VARCHAR(32)  NULL,
  birth_date              DATE         NULL,
  height                  TINYINT UNSIGNED NULL,
  weight                  SMALLINT UNSIGNED NULL,
  college                 VARCHAR(128) NULL,
  gsis_id                 VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  espn_id                 INT UNSIGNED NULL,
  sportradar_id           VARCHAR(64) CHARACTER SET ascii NULL,
  yahoo_id                INT UNSIGNED NULL,
  rotowire_id             INT UNSIGNED NULL,
  pff_id                  INT UNSIGNED NULL,
  pfr_id                  VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fantasy_data_id         INT UNSIGNED NULL,
  sleeper_id              INT UNSIGNED NULL,
  years_exp               TINYINT UNSIGNED NULL,
  headshot_url            VARCHAR(128) NULL,
  ngs_position            VARCHAR(32)  NULL,
  week                    TINYINT UNSIGNED NULL,
  game_type               ENUM('CON','DIV','REG','SB','WC') NULL,
  status_description_abbr VARCHAR(4)   NULL,
  football_name           VARCHAR(32)  NULL,
  esb_id                  VARCHAR(16) CHARACTER SET ascii NULL,
  gsis_it_id              INT UNSIGNED NULL,
  smart_id                VARCHAR(64) CHARACTER SET ascii NULL,
  entry_year              SMALLINT UNSIGNED NULL,
  rookie_year             SMALLINT UNSIGNED NULL,
  draft_club              VARCHAR(4) CHARACTER SET ascii NULL,
  draft_number            SMALLINT UNSIGNED NULL,
  PRIMARY KEY (season, team, gsis_id),
  CONSTRAINT fk_roster_team FOREIGN KEY (team) REFERENCES team (team_abbr)
) ENGINE = InnoDB;
