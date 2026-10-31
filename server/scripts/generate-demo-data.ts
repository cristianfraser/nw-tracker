/**
 * Generate a synthetic DB (src/demoData, docs/demo-generator-plan.md): a person's life told
 * through cartolas, card statements and payslips, imported through the real import paths.
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts [--real-market]
 *   NW_TRACKER_TEST_DB=nw-tracker.test.db npx tsx scripts/generate-demo-data.ts --test
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * Default: the hosted demo's person (2016 → today). `--real-market` fills the market tables from
 * the real sources first, as the demo's build does (needs the network and BCENTRAL_EMAIL /
 * BCENTRAL_PASSWORD); without it the market is synthetic (offline).
 *
 * `--test`: the Vitest person (about twenty months ending today, synthetic market), also built by
 * vitest.globalSetup when the test DB is missing.
 */
import { loadDemoRealMarket } from "../src/demoData/demoRealMarket.js";
import { generateDemoDb } from "../src/demoData/generate.js";
import { demoMarketSpec } from "../src/demoData/market.js";
import { DEMO_PERSON, testPerson } from "../src/demoData/person.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";

if (!process.env.NW_TRACKER_TEST_DB?.trim()) throw new Error("set NW_TRACKER_TEST_DB to a fresh DB file");
const test = process.argv.includes("--test");
const real = process.argv.includes("--real-market");
if (test && real) throw new Error("--real-market applies to the demo person only");
if (real) await loadDemoRealMarket(demoMarketSpec());
const person = test ? testPerson(chileCalendarTodayYmd()) : DEMO_PERSON;
const r = generateDemoDb({ person, market: real ? "real" : "synthetic" });
const { byAccount, ...summary } = r;
console.log(`synthetic data (${test ? "test" : "demo"}): ${JSON.stringify(summary)}`);
for (const a of byAccount) console.log(`  ${a.name.padEnd(24)} ${a.clp}`);
