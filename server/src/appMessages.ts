import { db } from "./db.js";

export type AppMessageKind = "notification" | "log";

export type AppMessageRow = {
  id: number;
  kind: AppMessageKind;
  created_at: string;
  read_at: string | null;
  title: string;
  body: string;
};

export function insertAppMessage(
  kind: AppMessageKind,
  title: string,
  body: string,
  dryRun = false
): number | null {
  if (dryRun) return null;
  const r = db
    .prepare(`INSERT INTO app_messages (kind, title, body) VALUES (?, ?, ?)`)
    .run(kind, title, body);
  return Number(r.lastInsertRowid);
}

export function listAppMessages(kind: AppMessageKind, limit = 200): AppMessageRow[] {
  return db
    .prepare(
      `SELECT id, kind, created_at, read_at, title, body FROM app_messages
       WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(kind, limit) as AppMessageRow[];
}

export function unreadNotificationCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM app_messages WHERE kind = 'notification' AND read_at IS NULL`
    )
    .get() as { c: number };
  return row.c ?? 0;
}

export function markAllNotificationsRead(): number {
  const r = db
    .prepare(
      `UPDATE app_messages SET read_at = datetime('now') WHERE kind = 'notification' AND read_at IS NULL`
    )
    .run();
  return r.changes;
}

/** A `log` row is deleted this many days after it was written. */
export const APP_MESSAGE_LOG_RETENTION_DAYS = 30;
/** A READ `notification` is deleted this many days after it was written; an unread one is never deleted. */
export const APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS = 180;

/** `datetime('now')` format, UTC — what `created_at` holds. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Deletes old messages: `log` rows older than {@link APP_MESSAGE_LOG_RETENTION_DAYS} and read
 * notifications older than {@link APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS} (by `created_at`).
 * Unread notifications stay whatever their age.
 *
 * The newest row of every title stays too: some state is read back from the latest message of a
 * title (`lastDailyRunAt` / `staleDailyRunDays` and the nightly repeat skip, the hourly poll's
 * failure badge and recovery walk in `dailyRunLog.ts`, `lastSyncRunCreatedAt`), and a
 * job silent for longer than the retention must still read as «last ran on …», not «never».
 * The only reference to a message by id is `app_message_failed_steps` (the steps a failed run
 * message names), deleted with it by its foreign key; a run's `message_id` is otherwise only
 * returned to the caller that recorded it.
 */
export function pruneAppMessages(now: Date = new Date()): { logs: number; notifications: number } {
  const day = 24 * 60 * 60_000;
  const logCutoff = sqliteUtc(new Date(now.getTime() - APP_MESSAGE_LOG_RETENTION_DAYS * day));
  const notificationCutoff = sqliteUtc(new Date(now.getTime() - APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS * day));
  const keepNewestPerTitle = `id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY title ORDER BY created_at DESC, id DESC) AS rn FROM app_messages
    ) WHERE rn = 1
  )`;
  return db.transaction(() => {
    const logs = db
      .prepare(`DELETE FROM app_messages WHERE kind = 'log' AND created_at < ? AND ${keepNewestPerTitle}`)
      .run(logCutoff).changes;
    const notifications = db
      .prepare(
        `DELETE FROM app_messages
         WHERE kind = 'notification' AND read_at IS NOT NULL AND created_at < ? AND ${keepNewestPerTitle}`
      )
      .run(notificationCutoff).changes;
    return { logs, notifications };
  })();
}
