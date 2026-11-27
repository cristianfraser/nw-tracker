-- The steps a failed run message names (`dailyRunLog.ts`). The message body lists them for a
-- person, but runtime must not parse it, and the hourly poll's badge rule compares a failure's
-- steps with the previous failure's: a step that was not failing before badges again. Written with
-- the message, deleted with it. Machine bookkeeping: no write-log triggers.
CREATE TABLE IF NOT EXISTS app_message_failed_steps (
  message_id INTEGER NOT NULL REFERENCES app_messages(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (message_id, label)
)
