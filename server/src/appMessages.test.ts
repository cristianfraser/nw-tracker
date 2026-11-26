import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_MESSAGE_LOG_RETENTION_DAYS,
  APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS,
  pruneAppMessages,
} from "./appMessages.js";
import { db } from "./db.js";
import { backupTick, pruneAppMessagesAfterDailySnapshot, resetDbBackupStateForTest } from "./dbBackupScheduler.js";

// Fixtures dated in 1990 under their own titles, pruned with a `now` in 1990: every row of the fork's
// database is newer than any cutoff, so only these can go.
const PREFIX = "vitest-prune ";
const NOW = new Date("1990-09-01T12:00:00Z");
const DAY = 24 * 60 * 60_000;

function stamp(msBeforeNow: number): string {
  return new Date(NOW.getTime() - msBeforeNow).toISOString().slice(0, 19).replace("T", " ");
}

function insert(kind: "log" | "notification", title: string, msBeforeNow: number, read = false): number {
  const created = stamp(msBeforeNow);
  return Number(
    db
      .prepare(`INSERT INTO app_messages (kind, title, body, created_at, read_at) VALUES (?, ?, 'x', ?, ?)`)
      .run(kind, PREFIX + title, created, read ? created : null).lastInsertRowid
  );
}

function surviving(): Set<number> {
  const rows = db.prepare(`SELECT id FROM app_messages WHERE title LIKE ?`).all(`${PREFIX}%`) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function cleanUp(): void {
  db.prepare(`DELETE FROM app_messages WHERE title LIKE ?`).run(`${PREFIX}%`);
}

describe("pruneAppMessages", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("deletes logs past 30 days and read notifications past 180 days, at the boundaries", () => {
    const logAtLimit = insert("log", "a", APP_MESSAGE_LOG_RETENTION_DAYS * DAY);
    const logPastLimit = insert("log", "a", APP_MESSAGE_LOG_RETENTION_DAYS * DAY + 1000);
    const logNewest = insert("log", "a", DAY);
    const readAtLimit = insert("notification", "n", APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS * DAY, true);
    const readPastLimit = insert("notification", "n", APP_MESSAGE_READ_NOTIFICATION_RETENTION_DAYS * DAY + 1000, true);
    const unreadAncient = insert("notification", "n", 400 * DAY);
    const notificationNewest = insert("notification", "n", DAY, true);
    // A notification 60 days old, read: past the log retention, inside the notification one.
    const readRecent = insert("notification", "n", 60 * DAY, true);

    expect(pruneAppMessages(NOW)).toEqual({ logs: 1, notifications: 1 });
    expect(surviving()).toEqual(
      new Set([logAtLimit, logNewest, readAtLimit, unreadAncient, notificationNewest, readRecent])
    );
    expect(surviving().has(logPastLimit)).toBe(false);
    expect(surviving().has(readPastLimit)).toBe(false);
  });

  it("keeps the newest row of every title, however old", () => {
    const oldest = insert("log", "quiet job", 300 * DAY);
    const newest = insert("log", "quiet job", 200 * DAY);
    const onlyNotification = insert("notification", "old badge", 500 * DAY, true);
    expect(pruneAppMessages(NOW)).toEqual({ logs: 1, notifications: 0 });
    expect(surviving()).toEqual(new Set([newest, onlyNotification]));
    expect(surviving().has(oldest)).toBe(false);
  });
});

describe("pruneAppMessagesAfterDailySnapshot", () => {
  const roots: string[] = [];
  const savedDir = process.env.DB_BACKUP_DIR;
  beforeEach(() => {
    cleanUp();
    resetDbBackupStateForTest();
  });
  afterEach(() => {
    cleanUp();
    resetDbBackupStateForTest();
    if (savedDir === undefined) delete process.env.DB_BACKUP_DIR;
    else process.env.DB_BACKUP_DIR = savedDir;
  });
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  it("prunes only once today's snapshot exists, and once per Chile day", async () => {
    insert("log", "gate", 100 * DAY);
    insert("log", "gate", 90 * DAY);
    pruneAppMessagesAfterDailySnapshot(NOW);
    expect(surviving().size).toBe(2);

    delete process.env.DB_BACKUP_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-vitest-prune-"));
    roots.push(dir);
    await backupTick({ destDir: dir });
    pruneAppMessagesAfterDailySnapshot(NOW);
    expect(surviving().size).toBe(1);

    insert("log", "gate", 120 * DAY);
    pruneAppMessagesAfterDailySnapshot(NOW);
    expect(surviving().size).toBe(2);
  });
});
