import { db } from "./db.js";
import { generateDemoDb } from "./demoData/generateDemoDb.js";

/**
 * Hosted recruiter-demo mode (`DEMO_MODE=1`): the server owns a dedicated synthetic
 * SQLite file and (re)generates it at boot when empty. Hosting free tiers have
 * ephemeral disks, so every cold start / deploy rebuilds the demo from current source —
 * the demo always matches the deployed code. Local personal mode never sets this flag.
 */
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "1";
}

/**
 * Demo-mode env defaults, applied only when the variable is not set explicitly.
 * Outbound syncs and DB backups are pointless against synthetic data; the dashboard
 * cache warmer (`CACHE_WARM_ENABLED`) stays default-on so first paint is warm.
 */
const DEMO_MODE_DEFAULT_ENV: ReadonlyArray<readonly [name: string, value: string]> = [
  ["GLOBAL_SYNC_ENABLED", "0"],
  ["LIVE_QUOTES_SYNC_ENABLED", "0"],
  ["DB_BACKUP_ENABLED", "0"],
];

/**
 * Call once at boot, after `loadRootDotenv()` and before the schedulers start.
 * Requires `NW_TRACKER_TEST_DB` so demo mode can never open (or generate into) the real
 * `nw-tracker.db`; `generateDemoDb` additionally refuses any DB that already has accounts.
 */
export function bootstrapDemoModeIfEnabled(): void {
  if (!demoModeEnabled()) return;
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    throw new Error(
      "DEMO_MODE=1 requires NW_TRACKER_TEST_DB to point at a dedicated demo DB file " +
        "(refusing to run demo mode against the real nw-tracker.db)."
    );
  }
  for (const [name, value] of DEMO_MODE_DEFAULT_ENV) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  const accounts = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (accounts > 0) {
    console.log(`demo mode: DB already populated (${accounts} accounts) — skipping generation`);
    return;
  }
  const r = generateDemoDb("demo");
  console.log(
    `demo mode: generated synthetic DB — ${r.months} months, ${r.movements} movements, ` +
      `${r.valuations} valuations, ${r.statements} CC statements`
  );
}
