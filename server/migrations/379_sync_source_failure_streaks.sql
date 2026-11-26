-- The unbroken run of failed attempts of each global-sync source (`syncSourceFailures.ts`). A
-- source's step that throws records or extends its row; the next successful step deletes it. The
-- sync log keeps every failure as text only, which runtime must not parse, so the streak a
-- «failing since» notification needs is kept here. Timestamps are UTC in `datetime('now')`
-- format, like `app_messages.created_at`. Machine bookkeeping: no write-log triggers.
CREATE TABLE IF NOT EXISTS sync_source_failure_streaks (
  source TEXT PRIMARY KEY,
  failing_since TEXT NOT NULL,
  last_failure_at TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 1),
  last_error TEXT NOT NULL,
  notified_at TEXT
);
