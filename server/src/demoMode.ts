import { db } from "./db.js";
import { loadDemoRealMarket } from "./demoData/demoRealMarket.js";
import { generateDemoDb } from "./demoData/generate.js";
import { demoMarketSpec } from "./demoData/market.js";
import { DEMO_PERSON } from "./demoData/person.js";

/**
 * Hosted recruiter-demo mode (`DEMO_MODE=1`): the server owns a dedicated synthetic
 * SQLite file. On Render the build generates it (`npm run demo:generate`, render.yaml), so a
 * deploy's boot only opens it; the boot generates only when it finds the DB empty (a local
 * rehearsal). Either way every deploy rebuilds the demo from current source — the demo always
 * matches the deployed code. Local personal mode never sets this flag. The demo's flag defaults
 * (market syncs on while someone browses, backups off, the usage log in its own file) and the
 * sources it never runs are the deployment profile's (`config.ts`).
 */
export { demoModeEnabled } from "./demoModeFlag.js";
import { demoModeEnabled } from "./demoModeFlag.js";

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
  const accounts = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (accounts > 0) {
    console.log(`demo mode: DB already populated (${accounts} accounts) — skipping generation`);
    return;
  }
  const market = await loadDemoRealMarket(demoMarketSpec());
  console.log(
    `demo mode: real market ${market.from} → ${market.through} — ` +
      Object.entries(market.equities).map(([t, n]) => `${t} ${n}`).join(", ") +
      `; fx ${market.fx}; BCentral usd ${market.bcentral.usd} uf ${market.bcentral.uf}; AFP official values ${market.afp_official}`
  );
  const r = generateDemoDb({ person: DEMO_PERSON, market: "real" });
  console.log(
    `demo mode: generated the demo DB — ${r.movements} movements, ${r.cartolas} cartolas, ` +
      `${r.statements} card statements, net worth US$${r.netWorthUsd}`
  );
}
