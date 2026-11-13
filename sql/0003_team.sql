-- team entity: one team code (ETL spec §7.2.1, data dictionary A4; ADR-0005).
-- Loaded first and by upsert so every team-code foreign key resolves (ADR-0006, §7.2).
-- Apply by hand (ADR-0011). Column types and nullability follow §7.2.2.

CREATE TABLE IF NOT EXISTS team (
  team_abbr            VARCHAR(4)   CHARACTER SET ascii NOT NULL,
  team_name            VARCHAR(32)  NULL,
  team_id              CHAR(4)      CHARACTER SET ascii NULL,
  team_nick            VARCHAR(16)  NULL,
  team_conf            ENUM('AFC','NFC') NULL,
  team_division        VARCHAR(16)  NULL,
  team_color           CHAR(7)      CHARACTER SET ascii NULL,
  team_color2          CHAR(7)      CHARACTER SET ascii NULL,
  team_color3          CHAR(7)      CHARACTER SET ascii NULL,
  team_color4          CHAR(7)      CHARACTER SET ascii NULL,
  team_logo_wikipedia  VARCHAR(255) NULL,
  team_logo_espn       VARCHAR(255) NULL,
  team_wordmark        VARCHAR(255) NULL,
  team_conference_logo VARCHAR(255) NULL,
  team_league_logo     VARCHAR(255) NULL,
  team_logo_squared    VARCHAR(255) NULL,
  PRIMARY KEY (team_abbr)
) ENGINE = InnoDB;
