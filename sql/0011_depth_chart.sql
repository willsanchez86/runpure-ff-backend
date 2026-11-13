-- depth_chart fact (dated snapshot): one player in one depth-chart slot at one snapshot
-- (ETL spec §7.2.1, data dictionary A9). Current season only (ADR-0013): a new season replaces it.
-- team carries a foreign key to team; gsis_id is a player reference with none and is nullable,
-- since 3.2% of rows carry only an ESPN ID (§7.2.3). Apply by hand (ADR-0011). Timestamps UTC;
-- types and nullability follow §7.2.2.

CREATE TABLE IF NOT EXISTS depth_chart (
  dt          DATETIME NOT NULL,
  team        VARCHAR(4) CHARACTER SET ascii NOT NULL,
  player_name VARCHAR(64) NULL,
  espn_id     INT UNSIGNED NULL,
  gsis_id     VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
  pos_grp_id  INT UNSIGNED NOT NULL,
  pos_grp     VARCHAR(32) NULL,
  pos_id      INT UNSIGNED NULL,
  pos_name    VARCHAR(32) NULL,
  pos_abb     VARCHAR(8)  NULL,
  pos_slot    TINYINT UNSIGNED NOT NULL,
  pos_rank    TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (dt, team, pos_grp_id, pos_slot, pos_rank),
  CONSTRAINT fk_depth_chart_team FOREIGN KEY (team) REFERENCES team (team_abbr)
) ENGINE = InnoDB;
