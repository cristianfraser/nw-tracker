import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { liveEnvText } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const defaultSnapshotsDir = path.join(dataDir, "snapshots");

/** Same rules as `db.ts` (without opening the shared connection). */
export function resolveDatabaseFilePath(): string {
  const override = liveEnvText("NW_TRACKER_TEST_DB");
  if (override) {
    if (override === ":memory:") return ":memory:";
    if (path.isAbsolute(override)) return path.resolve(override);
    return path.join(dataDir, override);
  }
  return path.join(dataDir, "nw-tracker.db");
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function timestampForFilename(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export type CreateDbSnapshotOpts = {
  /** Optional suffix (e.g. `before-cc-usd-import`). */
  label?: string;
  /** Defaults to `server/data/snapshots/`. */
  destDir?: string;
  /** Tests: the database to copy (default: the server's, `resolveDatabaseFilePath`). */
  sourcePath?: string;
};

export type CreateDbSnapshotResult = {
  path: string;
  label: string;
  bytes: number;
};

/**
 * A copy in progress is written as `.<final name>.tmp` beside its final name: hidden, and not a `.db`,
 * so `listDbSnapshots` and the retention rule never see it, and a kill mid-copy cannot leave a
 * truncated file under a snapshot's name.
 */
export function snapshotTempPath(destDir: string, fileName: string): string {
  return path.join(destDir, `.${fileName}.tmp`);
}

const TEMP_FILE_RE = /^\..+\.db\.tmp(-journal|-wal|-shm)?$/;
/** A temp file untouched this long is a killed run's (a copy in progress keeps writing to it). */
export const STALE_SNAPSHOT_TEMP_MS = 60 * 60_000;

/** Deletes the temp files a killed copy left in `destDir`; returns their names. */
export function removeStaleSnapshotTemps(destDir: string, nowMs = Date.now()): string[] {
  if (!fs.existsSync(destDir)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(destDir)) {
    if (!TEMP_FILE_RE.test(name)) continue;
    const file = path.join(destDir, name);
    if (nowMs - fs.statSync(file).mtimeMs < STALE_SNAPSHOT_TEMP_MS) continue;
    fs.rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}

/** Opens `file` read-only and throws unless SQLite's `quick_check` answers exactly «ok». */
export function verifySnapshotFile(file: string): void {
  let rows: unknown[];
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    rows = copy.pragma("quick_check") as unknown[];
  } finally {
    copy.close();
  }
  const answers = rows.map((r) => String(Object.values(r as Record<string, unknown>)[0]));
  if (answers.length !== 1 || answers[0] !== "ok") {
    throw new Error(`Snapshot failed quick_check (${file}): ${answers.slice(0, 5).join("; ")}`);
  }
}

/** Deletes `file` and the journal files SQLite may have left beside it. */
function removeWithSiblings(file: string): void {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

/**
 * Consistent SQLite backup via better-sqlite3 (includes WAL checkpoint), proven before it counts:
 * written under a temp name, `quick_check`ed read-only, then renamed to its final name (a rename in
 * one folder is atomic). A copy that fails the check is deleted and the call throws.
 * Refuses `:memory:` — point NW_TRACKER_TEST_DB at a file for tests.
 */
export async function createDbSnapshot(
  opts?: CreateDbSnapshotOpts
): Promise<CreateDbSnapshotResult> {
  const srcPath = opts?.sourcePath ?? resolveDatabaseFilePath();
  if (srcPath === ":memory:") {
    throw new Error("Cannot snapshot an in-memory database");
  }
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Database file not found: ${srcPath}`);
  }

  const destDir = opts?.destDir ?? defaultSnapshotsDir;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of removeStaleSnapshotTemps(destDir)) console.log(`db-snapshot: removed stale temp file ${name}`);

  const baseLabel = opts?.label ? sanitizeLabel(opts.label) : "snapshot";
  const fileName = `${timestampForFilename()}-${baseLabel}.db`;
  const destPath = path.join(destDir, fileName);
  const tempPath = snapshotTempPath(destDir, fileName);

  try {
    const src = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(tempPath);
    } finally {
      src.close();
    }
    verifySnapshotFile(tempPath);
    fs.renameSync(tempPath, destPath);
    // A read-only open of a WAL-mode copy may leave its index files behind under the temp name.
    for (const f of [`${tempPath}-wal`, `${tempPath}-shm`]) fs.rmSync(f, { force: true });
  } catch (e) {
    removeWithSiblings(tempPath);
    throw e;
  }
  const bytes = fs.statSync(destPath).size;
  return { path: destPath, label: baseLabel, bytes };
}

export function listDbSnapshots(destDir = defaultSnapshotsDir): { path: string; bytes: number; mtimeMs: number }[] {
  if (!fs.existsSync(destDir)) return [];
  return fs
    .readdirSync(destDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const p = path.join(destDir, f);
      const st = fs.statSync(p);
      return { path: p, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
