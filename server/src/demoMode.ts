import { db } from "./db.js";
import { generateDemoDb } from "./demoData/generateDemoDb.js";
import { demoNarrativeForPreset } from "./demoData/demoNarrative.js";
import { loadDemoRealMarket } from "./demoData/demoRealMarket.js";

/**
 * Hosted recruiter-demo mode (`DEMO_MODE=1`): the server owns a dedicated synthetic
 * SQLite file and (re)generates it at boot when empty. Hosting free tiers have
 * ephemeral disks, so every cold start / deploy rebuilds the demo from current source —
 * the demo always matches the deployed code. Local personal mode never sets this flag.
 */
export { demoModeEnabled } from "./demoModeFlag.js";
import { demoModeEnabled } from "./demoModeFlag.js";

/**
 * Demo-mode env defaults, applied only when the variable is not set explicitly.
 * The demo runs on real market data (2026-10-31): the global sync and the live quotes are on,
 * but only while someone is browsing (`demoMarketActivity.ts`) and only for the public market
 * sources (`demoSyncDisabledSources`). DB backups are pointless against a regenerated DB; the
 * dashboard cache warmer (`CACHE_WARM_ENABLED`) stays default-on so first paint is warm. The usage log
 * is set on before `applyBackgroundJobsEnvDefaults` can default it off: the demo writes it to
 * its own analytics file (usageDb.ts), so a demo rehearsal cannot collide with the primary.
 */
const DEMO_MODE_DEFAULT_ENV: ReadonlyArray<readonly [name: string, value: string]> = [
  ["GLOBAL_SYNC_ENABLED", "1"],
  ["LIVE_QUOTES_SYNC_ENABLED", "1"],
  ["DB_BACKUP_ENABLED", "0"],
  ["USAGE_LOG_ENABLED", "1"],
];

/**
 * Call once at boot, after `loadRootDotenv()` and before the schedulers start.
 * Requires `NW_TRACKER_TEST_DB` so demo mode can never open (or generate into) the real
 * `nw-tracker.db`; `generateDemoDb` additionally refuses any DB that already has accounts.
 * An empty DB is filled with real market history first (`loadDemoRealMarket`, which retries
 * each source for ~10 minutes and then throws, failing the boot).
 */
export async function bootstrapDemoModeIfEnabled(): Promise<void> {
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
  const market = await loadDemoRealMarket(demoNarrativeForPreset("demo"));
  console.log(
    `demo mode: real market ${market.from} → ${market.through} — ` +
      Object.entries(market.equities).map(([t, n]) => `${t} ${n}`).join(", ") +
      `; fx ${market.fx}; BCentral usd ${market.bcentral.usd} uf ${market.bcentral.uf}; AFP ${market.afp_official}; AFC ${market.afc}`
  );
  const r = generateDemoDb("demo", { market: "real" });
  console.log(
    `demo mode: generated the demo DB — ${r.months} months, ${r.movements} movements, ` +
      `${r.valuations} valuations, ${r.statements} CC statements`
  );
}
