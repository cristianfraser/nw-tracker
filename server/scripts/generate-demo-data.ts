/**
 * Generate a synthetic DB (demo or test preset).
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts --preset=demo
 *   NW_TRACKER_TEST_DB=nw-tracker.test.db npx tsx scripts/generate-demo-data.ts --preset=test
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * Presets (src/demoData/demoNarrative.ts): `demo` = rich 8-year recruiter-demo story
 * (3 cards, cuotas, USD statements, property); `test` = lean deterministic Vitest data
 * (also built automatically by vitest.globalSetup when the test DB is missing).
 */
import { generateDemoDb } from "../src/demoData/generateDemoDb.js";
import type { DemoPreset } from "../src/demoData/demoNarrative.js";

const presetArg = process.argv.find((a) => a.startsWith("--preset="))?.slice("--preset=".length);
if (presetArg && presetArg !== "test" && presetArg !== "demo") {
  throw new Error(`unknown --preset=${presetArg} (use demo or test)`);
}
const preset: DemoPreset = presetArg === "test" ? "test" : "demo";

const r = generateDemoDb(preset);
console.log(
  `demo data (${preset}): ${r.months} months — ${r.movements} movements, ${r.valuations} valuations, ` +
    `${r.statements} CC statements, ${r.statementLines} CC lines, ${r.installmentPurchases} installment purchases`
);
