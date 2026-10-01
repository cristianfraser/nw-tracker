import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";

/**
 * Where the Racional crawl stops (`cfraser/.racional-crawl-cursor.json`): the list key
 * (`racionalListRowKey`) of the first row — the newest, in the app's own order — of the newest
 * staged read the server applied without a blocked row. The crawl stages only the rows above it;
 * no cursor → the whole rendered list. Ingest's own state: the server keeps what it needs (how
 * far the list has been read cleanly) in its database.
 */
export type RacionalCrawlCursor = {
  last_row_key: string;
  /** The read the key came from (`movements-<stamp>.json`); reads sort chronologically by name. */
  read_file: string;
  updated_at: string;
};

export function resolveRacionalCrawlCursorPath(): string {
  return path.join(resolveCfraserDir(), ".racional-crawl-cursor.json");
}

export function readRacionalCrawlCursor(file = resolveRacionalCrawlCursorPath()): RacionalCrawlCursor | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RacionalCrawlCursor;
  } catch (err) {
    throw new Error(`${file} is not valid JSON — fix or delete it (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Moves the cursor to `next` when its read is newer than the current one; never back (reads are
 * sent oldest first, and an older one applying late must not rewind the crawl). True when moved.
 */
export function advanceRacionalCrawlCursor(
  next: Omit<RacionalCrawlCursor, "updated_at">,
  nowIso: string,
  file = resolveRacionalCrawlCursorPath()
): boolean {
  const current = readRacionalCrawlCursor(file);
  if (current && current.read_file >= next.read_file) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...next, updated_at: nowIso }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}
