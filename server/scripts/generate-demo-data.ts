/**
 * Generate a synthetic DB (src/demoData, docs/demo-generator-plan.md): a person's life told
 * through cartolas, card statements and payslips, imported through the real import paths.
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts [market flag]
 *   NW_TRACKER_TEST_DB=nw-tracker.test.db npx tsx scripts/generate-demo-data.ts --test
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * Default: the hosted demo's person (2016 → today) on a synthetic market (offline). Real market:
 * - `--market-asset`: the market the home server publishes every night as a GitHub Release asset
 *   (docs/demo-market-publish-plan.md) — what the Render build runs (`npm run demo:generate`);
 * - `--market-asset-file=<path>`: the same from a local artifact file (a rehearsal; the publish
 *   script writes one with `--out`);
 * - `--real-market`: fetched from the sources directly (Yahoo, Banco Central — needs
 *   BCENTRAL_EMAIL / BCENTRAL_PASSWORD — AFP UNO), the Santiago closes from the committed
 *   snapshot, or from the Bolsa itself with `--santiago=bolsa` (`npm run demo:generate:fetch`).
 *
 * `--test`: the Vitest person (about twenty months ending today, synthetic market), also built by
 * vitest.globalSetup when the test DB is missing.
 */
import { loadDemoMarketFromAsset, loadDemoRealMarket, type DemoSantiagoSource } from "../src/demoData/demoRealMarket.js";
import { generateDemoDb } from "../src/demoData/generate.js";
import { demoMarketSpec } from "../src/demoData/market.js";
import { DEMO_PERSON, testPerson } from "../src/demoData/person.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { saveDemoPristineCopy } from "../src/demoWritable.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

// `--real-market` reads BCENTRAL_* from the root .env on a local machine (Render sets them).
loadRootDotenv();
if (!process.env.NW_TRACKER_TEST_DB?.trim()) throw new Error("set NW_TRACKER_TEST_DB to a fresh DB file");
const args = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a == null ? null : a.slice(name.length + 3);
};
const test = args.includes("--test");
const fetchMarket = args.includes("--real-market");
const fromAsset = args.includes("--market-asset");
const assetFile = flagValue("market-asset-file");
const santiago = flagValue("santiago") ?? "snapshot";
if (santiago !== "snapshot" && santiago !== "bolsa") throw new Error(`--santiago=${santiago}: expected snapshot or bolsa`);
const marketModes = [fetchMarket, fromAsset, assetFile != null].filter(Boolean).length;
if (marketModes > 1) throw new Error("pick one of --real-market, --market-asset, --market-asset-file=");
const real = marketModes === 1;
if (test && real) throw new Error("a real market applies to the demo person only");

if (fetchMarket) {
  await loadDemoRealMarket(demoMarketSpec(), new Date(), { santiago: santiago as DemoSantiagoSource });
} else if (fromAsset || assetFile != null) {
  const m = await loadDemoMarketFromAsset(demoMarketSpec(), { file: assetFile ?? undefined });
  console.log(
    `demo market from ${m.source}: generated ${m.generated_at}, complete through ${m.complete_through} — ` +
      Object.entries(m.rows).map(([t, n]) => `${t} ${n}`).join(", ")
  );
}
const person = test ? testPerson(chileCalendarTodayYmd()) : DEMO_PERSON;
const r = generateDemoDb({ person, market: real ? "real" : "synthetic" });
const { byAccount, ...summary } = r;
console.log(`synthetic data (${test ? "test" : "demo"}): ${JSON.stringify(summary)}`);
for (const a of byAccount) console.log(`  ${a.name.padEnd(24)} ${a.clp}`);
// The hosted demo resets to this copy when visitors' edits pile up (src/demoWritable.ts).
if (!test) {
  saveDemoPristineCopy();
  console.log("saved the generated state beside the DB (.pristine)");
}
