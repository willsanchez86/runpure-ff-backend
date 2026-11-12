-- roster fact (membership): one player on one team in one season (ETL spec §7.2.1, data dictionary A6).
-- team and draft_club carry foreign keys to team; gsis_id and pfr_id are player references with
-- none (§7.2). Rows with no player ID are dropped by the load, so gsis_id is NOT NULL (§8).
-- status is nullable: one profiled row has an empty status, which the load stores as NULL (§6).
-- Apply by hand (ADR-0011). Types and nullability follow §7.2.2.

CREATE TABLE IF NOT EXISTS roster (
  season                  SMALLINT UNSIGNED NOT NULL,
  team                    VARCHAR(4) CHARACTER SET ascii NOT NULL,
  position                VARCHAR(4) CHARACTER SET ascii NOT NULL,
  depth_chart_position    VARCHAR(4)   NOT NULL,
  jersey_number           TINYINT UNSIGNED NULL,
  status                  VARCHAR(4) CHARACTER SET ascii NULL,
  full_name               VARCHAR(64)  NOT NULL,
  first_name              VARCHAR(32)  NOT NULL,
  last_name               VARCHAR(32)  NOT NULL,
  birth_date              DATE         NULL,
  height                  TINYINT UNSIGNED NULL,
  weight                  SMALLINT UNSIGNED NOT NULL,
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
  week                    TINYINT UNSIGNED NOT NULL,
  game_type               ENUM('CON','DIV','REG','SB','WC') NOT NULL,
  status_description_abbr VARCHAR(4)   NULL,
  football_name           VARCHAR(32)  NOT NULL,
  esb_id                  VARCHAR(16) CHARACTER SET ascii NULL,
  gsis_it_id              INT UNSIGNED NOT NULL,
  smart_id                VARCHAR(64) CHARACTER SET ascii NULL,
  entry_year              SMALLINT UNSIGNED NULL,
  rookie_year             SMALLINT UNSIGNED NULL,
  draft_club              VARCHAR(4) CHARACTER SET ascii NULL,
  draft_number            SMALLINT UNSIGNED NULL,
  PRIMARY KEY (season, team, gsis_id),
  CONSTRAINT fk_roster_team       FOREIGN KEY (team)       REFERENCES team (team_abbr),
  CONSTRAINT fk_roster_draft_club FOREIGN KEY (draft_club) REFERENCES team (team_abbr)
) ENGINE = InnoDB;
