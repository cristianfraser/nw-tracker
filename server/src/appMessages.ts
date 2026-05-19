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
