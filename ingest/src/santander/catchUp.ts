import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir, resolveMovementsDir } from "../paths.js";
import { lastRunAt } from "../runGuard.js";

/**
 * Should the hourly poll retry the Santander fetch the 22:00 run failed (or never made)?
 *
 * The nightly fetch is the only thing that reads the card's unbilled movements, so a failure left
 * a whole day unfetched — on 2026-09-25 the Mac slept through 22:00, the catch-up run launchd fired
 * at wake met the bank's connection-error panel, and nothing retried until the next night. Across a
 * facturación close that hole is worse than a delay: the purchases made between the last good
 * fetch and the close leave the unbilled feed at the close and only come back with the statement.
 *
 * One retry per slot, no more: the fetch is a bank login, and the intended rhythm is one a day.
 * Due when all of these hold —
 *  - no fetch has succeeded since the latest 22:00 slot (the newest `card-movements-*.json`),
 *  - no catch-up was tried for that slot yet (`.santander-catchup.json`),
 *  - the last attempt against the bank is at least {@link MIN_GAP_AFTER_ATTEMPT_MINUTES} old, so
 *    the scraper's own 30-minute run guard never refuses it,
 *  - the login is not latched off after a credentials rejection (retrying a wrong clave is how a
 *    bank blocks it; the nightly already reports that).
 */

/** A slot counts as passed 30 minutes after 22:00, once the nightly run has had its chance. */
const SLOT_GRACE = "22:30";
const MIN_GAP_AFTER_ATTEMPT_MINUTES = 35;

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

function previousDayYmd(ymd: string): string {
  const t = Date.parse(`${ymd}T12:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The latest nightly slot whose grace period has passed, as a Chile wall-clock string. */
export function latestPassedSlot(now: Date): string {
  const wall = chileWallClock(now);
  const [ymd, hm] = wall.split(" ") as [string, string];
  return hm >= SLOT_GRACE ? `${ymd} 22:00` : `${previousDayYmd(ymd)} 22:00`;
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

function catchUpStateFile(): string {
  return path.join(resolveCfraserDir(), ".santander-catchup.json");
}

function lastCatchUpAt(): Date | null {
  const file = catchUpStateFile();
  if (!fs.existsSync(file)) return null;
  const raw = (JSON.parse(fs.readFileSync(file, "utf8")) as { last_attempt_at?: string }).last_attempt_at;
  const at = raw ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

export function recordCatchUpAttempt(now: Date = new Date()): void {
  fs.writeFileSync(catchUpStateFile(), JSON.stringify({ last_attempt_at: now.toISOString() }, null, 2));
}

export type CatchUpDecision = { due: boolean; reason: string };

export function santanderCatchUpDecision(now: Date = new Date()): CatchUpDecision {
  const slot = latestPassedSlot(now);
  const lastSuccess = lastSuccessfulSantanderFetchAt();
  if (lastSuccess && chileWallClock(lastSuccess) >= slot) {
    return { due: false, reason: `fetched since the ${slot} slot (${chileWallClock(lastSuccess)})` };
  }
  const lastCatchUp = lastCatchUpAt();
  if (lastCatchUp && chileWallClock(lastCatchUp) >= slot) {
    return { due: false, reason: `already retried for the ${slot} slot (${chileWallClock(lastCatchUp)})` };
  }
  if (fs.existsSync(path.join(resolveCfraserDir(), ".santander-login-rejected.json"))) {
    return { due: false, reason: "login latched off after a credentials rejection" };
  }
  const lastAttempt = lastRunAt("santander");
  if (lastAttempt) {
    const ageMinutes = (now.getTime() - lastAttempt.getTime()) / 60_000;
    if (ageMinutes < MIN_GAP_AFTER_ATTEMPT_MINUTES) {
      return {
        due: false,
        reason: `last attempt ${Math.floor(ageMinutes)} min ago — waiting ${MIN_GAP_AFTER_ATTEMPT_MINUTES} min`,
      };
    }
  }
  return {
    due: true,
    reason:
      `no Santander fetch has succeeded since the ${slot} slot` +
      (lastSuccess ? ` (last: ${chileWallClock(lastSuccess)})` : ""),
  };
}
