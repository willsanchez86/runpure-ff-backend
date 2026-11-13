-- snap_count fact: one player in one game (ETL spec §7.2.1, data dictionary A8).
-- Players are identified by Pro Football Reference ID, not GSIS; it joins to player.pfr_id (§7.2.3).
-- team and opponent carry foreign keys to team; game_id and pfr_player_id are references with
-- none (§7.2). Apply by hand (ADR-0011). Types and nullability follow §7.2.2.

CREATE TABLE IF NOT EXISTS snap_count (
  game_id       VARCHAR(32) CHARACTER SET ascii NOT NULL,
  pfr_game_id   VARCHAR(16) CHARACTER SET ascii NULL,
  season        SMALLINT UNSIGNED NULL,
  game_type     ENUM('CON','DIV','REG','SB','WC') NULL,
  week          TINYINT UNSIGNED NULL,
  player        VARCHAR(64) NULL,
  pfr_player_id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position      VARCHAR(8) CHARACTER SET ascii NULL,
  team          VARCHAR(4) CHARACTER SET ascii NULL,
  opponent      VARCHAR(4) CHARACTER SET ascii NULL,
  offense_snaps TINYINT UNSIGNED NULL,
  offense_pct   DOUBLE      NULL,
  defense_snaps TINYINT UNSIGNED NULL,
  defense_pct   DOUBLE      NULL,
  st_snaps      TINYINT UNSIGNED NULL,
  st_pct        DOUBLE      NULL,
  PRIMARY KEY (game_id, pfr_player_id),
  CONSTRAINT fk_snap_count_team     FOREIGN KEY (team)     REFERENCES team (team_abbr),
  CONSTRAINT fk_snap_count_opponent FOREIGN KEY (opponent) REFERENCES team (team_abbr)
) ENGINE = InnoDB;
