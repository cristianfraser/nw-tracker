import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const defaultSnapshotsDir = path.join(dataDir, "snapshots");

/** Same rules as `db.ts` (without opening the shared connection). */
export function resolveDatabaseFilePath(): string {
  const override = process.env.NW_TRACKER_TEST_DB?.trim();
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
};

export type CreateDbSnapshotResult = {
  path: string;
  label: string;
  bytes: number;
};

/**
 * Consistent SQLite backup via better-sqlite3 (includes WAL checkpoint).
 * Refuses `:memory:` — point NW_TRACKER_TEST_DB at a file for tests.
 */
export async function createDbSnapshot(
  opts?: CreateDbSnapshotOpts
): Promise<CreateDbSnapshotResult> {
  const srcPath = resolveDatabaseFilePath();
  if (srcPath === ":memory:") {
    throw new Error("Cannot snapshot an in-memory database");
  }
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Database file not found: ${srcPath}`);
  }

  const destDir = opts?.destDir ?? defaultSnapshotsDir;
  fs.mkdirSync(destDir, { recursive: true });

  const baseLabel = opts?.label ? sanitizeLabel(opts.label) : "snapshot";
  const fileName = `${timestampForFilename()}-${baseLabel}.db`;
  const destPath = path.join(destDir, fileName);

  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(destPath);
  } finally {
    src.close();
  }

  if (!fs.existsSync(destPath)) {
    throw new Error(`Snapshot file was not created: ${destPath}`);
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
