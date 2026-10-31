/**
 * Generate a synthetic DB (demo or test preset).
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts --preset=demo
 *   NW_TRACKER_TEST_DB=nw-tracker.test.db npx tsx scripts/generate-demo-data.ts --preset=test
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * `--real-market` (demo preset): fill the market tables from the real sources first, as the
 * hosted demo does at boot (needs the network and BCENTRAL_EMAIL / BCENTRAL_PASSWORD).
 *
 * Presets (src/demoData/demoNarrative.ts): `demo` = rich 8-year recruiter-demo story
 * (3 cards, cuotas, USD statements, property); `test` = lean deterministic Vitest data
 * (also built automatically by vitest.globalSetup when the test DB is missing).
 */
import { generateDemoDb } from "../src/demoData/generateDemoDb.js";
import { demoNarrativeForPreset, type DemoPreset } from "../src/demoData/demoNarrative.js";
import { loadDemoRealMarket } from "../src/demoData/demoRealMarket.js";

const presetArg = process.argv.find((a) => a.startsWith("--preset="))?.slice("--preset=".length);
if (presetArg && presetArg !== "test" && presetArg !== "demo") {
  throw new Error(`unknown --preset=${presetArg} (use demo or test)`);
}
const preset: DemoPreset = presetArg === "test" ? "test" : "demo";

const realMarket = process.argv.includes("--real-market");
if (realMarket) await loadDemoRealMarket(demoNarrativeForPreset(preset));
const r = generateDemoDb(preset, { market: realMarket ? "real" : "synthetic" });
console.log(
  `demo data (${preset}): ${r.months} months — ${r.movements} movements, ${r.valuations} valuations, ` +
    `${r.statements} CC statements, ${r.statementLines} CC lines, ${r.installmentPurchases} installment purchases`
);
