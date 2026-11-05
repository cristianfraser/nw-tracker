import fs from "node:fs";
import path from "node:path";
import { resolveMovementsDir } from "../paths.js";

/** When the Santander card feed was last fetched, and the Chile wall clock its readers compare on. */

/** `YYYY-MM-DD HH:MM` on the Chile wall clock — comparable as strings. */
export function chileWallClock(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** `card-movements-2026-09-25T15-55-26.json` (UTC stamp) → its instant. */
function stampToDate(name: string): Date | null {
  const m = /^card-movements-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.json$/.exec(name);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** When the newest card-movements file was fetched (staged or already imported), if any. */
export function lastSuccessfulSantanderFetchAt(): Date | null {
  const dir = resolveMovementsDir("santander");
  let latest: Date | null = null;
  for (const d of [dir, path.join(dir, "imported")]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const at = stampToDate(name);
      if (at && (!latest || at > latest)) latest = at;
    }
  }
  return latest;
}
