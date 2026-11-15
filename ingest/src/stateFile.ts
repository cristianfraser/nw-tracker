import fs from "node:fs";

/**
 * A JSON state file the ingest keeps between runs (a ledger, a watermark, a guard). No file is the
 * empty state: null. A file that cannot be read, is not JSON, or is not a JSON object throws,
 * naming it — a corrupt state is not an empty one (an emptied guard lets a bank run through, an
 * emptied ledger downloads every document again). Same rule as `racional/crawlCursor.ts`.
 */
export function readJsonStateFile(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON — fix or delete it (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object — fix or delete it`);
  }
  return parsed as Record<string, unknown>;
}
