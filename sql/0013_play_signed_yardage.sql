-- The data dictionary sized these two from profiled seasons where every value
-- happened to be a small positive number (ranges "1 to 3" / "0 to 3"), but both
-- are yardage figures that can be negative — the 2026 week 10 file carries a
-- negative fumble_recovery_2_yards, which overflows TINYINT UNSIGNED and fails
-- the load. SMALLINT matches their _1 siblings (ETL spec v2.18).
ALTER TABLE play
  MODIFY COLUMN lateral_rushing_yards SMALLINT NULL,
  MODIFY COLUMN fumble_recovery_2_yards SMALLINT NULL;
