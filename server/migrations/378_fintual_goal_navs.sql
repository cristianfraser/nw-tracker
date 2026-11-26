-- The balance Fintual's goals API stated for each tracked goal at the latest poll. It used to live
-- only in the sync state file (`fintualLastCheckSig`), where the goals-NAV display choice and the
-- reconcile checks read it as a value: outside the database, the change log and data_version.
-- One row per goal, replaced by every poll that reaches the goals (`fintualGoalNavs.ts`); the
-- state file keeps its signature for scheduling only. The hook adds the write-log triggers.
CREATE TABLE IF NOT EXISTS fintual_goal_navs (
  goal_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nav_amount REAL NOT NULL CHECK (nav_amount >= 0),
  currency TEXT NOT NULL REFERENCES currencies(code),
  polled_ymd TEXT NOT NULL CHECK (polled_ymd GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
);
