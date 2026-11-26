/**
 * The snapshot writer and the retention rule on real folders (`dbSnapshot.ts`,
 * `pruneDbSnapshots` in `dbBackupScheduler.ts`): a damaged source never becomes a listed
 * snapshot, and a day holding several labels keeps its newest snapshot only, whatever else lies in
 * the folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { pruneDbSnapshots } from "./dbBackupScheduler.js";
import { createDbSnapshot, listDbSnapshots, snapshotTempPath } from "./dbSnapshot.js";

const roots: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nw-vitest-prune-"));
  roots.push(d);
  return d;
}

afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

/** A database of many pages, then cut to half its size (a copy interrupted mid-write). */
function truncatedDatabase(dir: string): string {
  const file = path.join(dir, "truncated.db");
  const d = new Database(file);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
  const ins = d.prepare("INSERT INTO t (body) VALUES (?)");
  d.transaction(() => {
    for (let i = 0; i < 4000; i++) ins.run(`row-${i}-${"y".repeat(60)}`);
  })();
  d.close();
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  return file;
}

const touch = (dir: string, name: string) => fs.writeFileSync(path.join(dir, name), "x");

describe("createDbSnapshot from a damaged source", () => {
  it("a truncated database is refused and leaves nothing in the folder", async () => {
    const src = truncatedDatabase(tmpDir());
    const dest = tmpDir();

    await expect(createDbSnapshot({ label: "vitest", destDir: dest, sourcePath: src })).rejects.toThrow();

    expect(fs.readdirSync(dest)).toEqual([]);
    expect(listDbSnapshots(dest)).toEqual([]);
  });

  it("a file that is not a database is refused", async () => {
    const dir = tmpDir();
    const src = path.join(dir, "not-a-db.db");
    fs.writeFileSync(src, "this is not SQLite ".repeat(500));
    const dest = tmpDir();

    await expect(createDbSnapshot({ label: "vitest", destDir: dest, sourcePath: src })).rejects.toThrow();

    expect(fs.readdirSync(dest)).toEqual([]);
  });
});

describe("pruneDbSnapshots: a day with several labels", () => {
  it("keeps the day's newest snapshot, removes the others with their journal files, and touches nothing else", () => {
    const dir = tmpDir();
    for (const name of [
      "20261108-004800-auto-daily.db",
      "20261109-004800-auto-daily.db",
      "20261109-031729-before-deploy-aaaa0003.db",
      "20261109-031729-before-deploy-aaaa0003.db-wal",
      "20261109-031729-before-deploy-aaaa0003.db-shm",
      "20261109-122910-snapshot.db",
      "manual-copy.db",
    ]) {
      touch(dir, name);
    }
    // A copy still being written, stamped later than every snapshot of the day: not a snapshot yet.
    const inProgress = path.basename(snapshotTempPath(dir, "20261109-235900-auto-daily.db"));
    touch(dir, inProgress);

    const pruned = pruneDbSnapshots(dir, 30, "2026-11-09");

    expect(pruned).toEqual(["20261109-004800-auto-daily.db", "20261109-031729-before-deploy-aaaa0003.db"]);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [inProgress, "20261108-004800-auto-daily.db", "20261109-122910-snapshot.db", "manual-copy.db"].sort()
    );
  });

  it("a fresh snapshot becomes its day's keeper over earlier ones of other labels", async () => {
    const dir = tmpDir();
    const made = await createDbSnapshot({ label: "vitest-fresh", destDir: dir, sourcePath: smallDatabase() });
    const stamp = path.basename(made.path).slice(0, 8);
    const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    touch(dir, `${stamp}-000000-auto-daily.db`);
    touch(dir, `${stamp}-000000-before-deploy-bbbb0001.db`);

    const pruned = pruneDbSnapshots(dir, 30, day);

    expect(pruned.sort()).toEqual([`${stamp}-000000-auto-daily.db`, `${stamp}-000000-before-deploy-bbbb0001.db`]);
    expect(listDbSnapshots(dir).map((s) => s.path)).toEqual([made.path]);
  });
});

function smallDatabase(): string {
  const file = path.join(tmpDir(), "small.db");
  const d = new Database(file);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t DEFAULT VALUES;");
  d.close();
  return file;
}
