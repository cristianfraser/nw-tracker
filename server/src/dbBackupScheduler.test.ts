import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  DB_BACKUP_FAILED_TITLE,
  DB_BACKUP_SECONDARY_FAILED_TITLE,
  backupTick,
  copySnapshotToDir,
  resetDbBackupStateForTest,
} from "./dbBackupScheduler.js";
import {
  STALE_SNAPSHOT_TEMP_MS,
  createDbSnapshot,
  listDbSnapshots,
  removeStaleSnapshotTemps,
  snapshotTempPath,
  verifySnapshotFile,
} from "./dbSnapshot.js";

const roots: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nw-vitest-snapshot-"));
  roots.push(d);
  return d;
}

/** A small database whose table pages are overwritten: it opens, but `quick_check` fails. */
function corruptDatabase(dir: string): string {
  const file = path.join(dir, "corrupt.db");
  const d = new Database(file);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
  const ins = d.prepare("INSERT INTO t (body) VALUES (?)");
  for (let i = 0; i < 2000; i++) ins.run(`row-${i}-${"x".repeat(40)}`);
  d.close();
  const fd = fs.openSync(file, "r+");
  const pageSize = 4096;
  for (let page = 2; page < 8; page++) fs.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, page * pageSize);
  fs.closeSync(fd);
  return file;
}

const tempFiles = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith("."));

const notifications = (title: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM app_messages WHERE kind = 'notification' AND title = ?`).get(title) as { c: number }).c;

afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

describe("createDbSnapshot", () => {
  it("writes a checked copy under its final name and leaves no temp file", async () => {
    const dir = tmpDir();
    const r = await createDbSnapshot({ label: "vitest", destDir: dir });
    expect(path.basename(r.path)).toMatch(/^\d{8}-\d{6}-vitest\.db$/);
    expect(listDbSnapshots(dir).map((s) => s.path)).toEqual([r.path]);
    expect(tempFiles(dir)).toEqual([]);
    expect(() => verifySnapshotFile(r.path)).not.toThrow();
  });

  it("throws on a copy that fails quick_check and keeps nothing of it", async () => {
    const src = corruptDatabase(tmpDir());
    expect(() => verifySnapshotFile(src)).toThrow(/quick_check|malformed/);
    const dir = tmpDir();
    await expect(createDbSnapshot({ label: "vitest", destDir: dir, sourcePath: src })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("removes a killed run's temp files, never a copy still being written", () => {
    const dir = tmpDir();
    const stale = snapshotTempPath(dir, "20260101-000000-auto-daily.db");
    const fresh = snapshotTempPath(dir, "20260102-000000-auto-daily.db");
    fs.writeFileSync(stale, "partial");
    fs.writeFileSync(`${stale}-journal`, "partial");
    fs.writeFileSync(fresh, "in progress");
    const old = (Date.now() - STALE_SNAPSHOT_TEMP_MS - 60_000) / 1000;
    fs.utimesSync(stale, old, old);
    fs.utimesSync(`${stale}-journal`, old, old);
    expect(removeStaleSnapshotTemps(dir).sort()).toEqual([path.basename(stale), `${path.basename(stale)}-journal`].sort());
    expect(fs.readdirSync(dir)).toEqual([path.basename(fresh)]);
    // A temp file is not a snapshot to the lister.
    expect(listDbSnapshots(dir)).toEqual([]);
  });
});

describe("copySnapshotToDir", () => {
  it("refuses a second folder that does not exist instead of creating it", async () => {
    const primary = tmpDir();
    const r = await createDbSnapshot({ label: "vitest", destDir: primary });
    const missing = path.join(tmpDir(), "unmounted-volume");
    expect(() => copySnapshotToDir(r.path, missing, 60)).toThrow(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("copies under the final name with no temp file left", async () => {
    const primary = tmpDir();
    const second = tmpDir();
    const r = await createDbSnapshot({ label: "vitest", destDir: primary });
    const dest = copySnapshotToDir(r.path, second, 60);
    expect(fs.readdirSync(second)).toEqual([path.basename(r.path)]);
    expect(fs.statSync(dest).size).toBe(r.bytes);
  });
});

describe("backupTick", () => {
  const savedDir = process.env.DB_BACKUP_DIR;
  const savedKeep = process.env.DB_BACKUP_KEEP;
  beforeEach(() => {
    resetDbBackupStateForTest();
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env.DB_BACKUP_DIR;
    else process.env.DB_BACKUP_DIR = savedDir;
    if (savedKeep === undefined) delete process.env.DB_BACKUP_KEEP;
    else process.env.DB_BACKUP_KEEP = savedKeep;
    db.prepare(`DELETE FROM app_messages WHERE title IN (?, ?)`).run(DB_BACKUP_FAILED_TITLE, DB_BACKUP_SECONDARY_FAILED_TITLE);
    resetDbBackupStateForTest();
  });

  it("still prunes the primary folder when the second copy fails, and notifies that once a day", async () => {
    const primary = tmpDir();
    // Two snapshots of one old month: retention keeps the newer only.
    fs.writeFileSync(path.join(primary, "20200105-010000-auto-daily.db"), "");
    fs.writeFileSync(path.join(primary, "20200106-010000-auto-daily.db"), "");
    process.env.DB_BACKUP_DIR = path.join(tmpDir(), "unmounted-volume");
    process.env.DB_BACKUP_KEEP = "30";
    await backupTick({ destDir: primary });
    const names = fs.readdirSync(primary);
    expect(names).not.toContain("20200105-010000-auto-daily.db");
    expect(names).toContain("20200106-010000-auto-daily.db");
    expect(names.filter((n) => n.endsWith("-auto-daily.db"))).toHaveLength(2);
    expect(notifications(DB_BACKUP_SECONDARY_FAILED_TITLE)).toBe(1);
    expect(notifications(DB_BACKUP_FAILED_TITLE)).toBe(0);
  });

  it("notifies a failed snapshot once per Chile day, however often the check runs", async () => {
    delete process.env.DB_BACKUP_DIR;
    const notADir = path.join(tmpDir(), "file");
    fs.writeFileSync(notADir, "");
    await backupTick({ destDir: notADir });
    await backupTick({ destDir: notADir });
    expect(notifications(DB_BACKUP_FAILED_TITLE)).toBe(1);
  });
});
