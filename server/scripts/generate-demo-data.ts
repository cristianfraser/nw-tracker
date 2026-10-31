/**
 * Generate a synthetic DB.
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts --preset=demo [--real-market]
 *   NW_TRACKER_TEST_DB=nw-tracker.test.db npx tsx scripts/generate-demo-data.ts --preset=test
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * `demo`: the hosted demo's person (src/demoData/v2, docs/demo-generator-plan.md): a life told
 * through cartolas, card statements and payslips imported through the real import paths.
 * `--real-market` fills the market tables from the real sources first, as the hosted demo's build
 * does (needs the network and BCENTRAL_EMAIL / BCENTRAL_PASSWORD); without it the market is
 * synthetic (offline).
 *
 * `test`: the lean deterministic Vitest data (src/demoData/demoNarrative.ts), also built
 * automatically by vitest.globalSetup when the test DB is missing.
 */
import { generateDemoDb } from "../src/demoData/generateDemoDb.js";
import { loadDemoRealMarket } from "../src/demoData/demoRealMarket.js";
import { generateDemoDbV2 } from "../src/demoData/v2/generate.js";
import { v2MarketSpec } from "../src/demoData/v2/market.js";

const presetArg = process.argv.find((a) => a.startsWith("--preset="))?.slice("--preset=".length);
if (presetArg && presetArg !== "test" && presetArg !== "demo") {
  throw new Error(`unknown --preset=${presetArg} (use demo or test)`);
}
const preset = presetArg === "test" ? "test" : "demo";
if (!process.env.NW_TRACKER_TEST_DB?.trim()) throw new Error("set NW_TRACKER_TEST_DB to a fresh DB file");

if (preset === "test") {
  if (process.argv.includes("--real-market")) throw new Error("--real-market applies to the demo preset only");
  const r = generateDemoDb("test");
  console.log(
    `demo data (test): ${r.months} months — ${r.movements} movements, ${r.valuations} valuations, ` +
      `${r.statements} CC statements, ${r.statementLines} CC lines, ${r.installmentPurchases} installment purchases`
  );
} else {
  const real = process.argv.includes("--real-market");
  if (real) await loadDemoRealMarket(v2MarketSpec());
  const r = generateDemoDbV2({ market: real ? "real" : "synthetic" });
  const { byAccount, ...summary } = r;
  console.log(`demo data (demo): ${JSON.stringify(summary)}`);
  for (const a of byAccount) console.log(`  ${a.name.padEnd(24)} ${a.clp}`);
}
