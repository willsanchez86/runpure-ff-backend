-- App accounts (ADR-0015, ADR-0001). Each account is keyed to its Firebase uid;
-- account-owned rows elsewhere carry users.id as user_id. Apply by hand (ADR-0011).
--
-- How accounts are created is not decided yet (system design, "Not decided"). Until
-- it is, add each account by hand after its first sign-in, for example:
--   INSERT INTO users (firebase_uid, is_operator) VALUES ('<uid from Firebase console>', TRUE);
-- is_operator grants the operator-only GraphQL fields (pipelineRuns, ingestLedger).

CREATE TABLE IF NOT EXISTS users (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  firebase_uid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_operator  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY uq_users_firebase_uid (firebase_uid)
) ENGINE = InnoDB;
