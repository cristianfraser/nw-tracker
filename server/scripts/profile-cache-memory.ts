/**
 * What the home warm keeps in memory, step by step, and which cache keys hold it — the report
 * to run when a small instance dies of «JavaScript heap out of memory» (the Render Starter demo,
 * 2026-11-09: a 256 MB V8 heap). Read-only; point it at a copy of the DB to profile:
 *
 *   cd server && NW_TRACKER_TEST_DB=/path/to/copy.db BACKGROUND_JOBS_ENABLED=0 \
 *     NODE_OPTIONS="--max-old-space-size=4096 --expose-gc" npx tsx scripts/profile-cache-memory.ts [--top=30]
 *
 * Sizes are the JSON length of each entry (a Map: a 50-entry sample scaled to its size), a lower
 * bound of the heap it takes — V8 objects cost about 2–3× their JSON.
 */
import { aggregationCacheKeysForTest, getAggregationCached } from "../src/cacheRegistry.js";
import { buildDashboardPageBundle } from "../src/dashboardPageBundle.js";
import { getDashboardOverviewDaily } from "../src/dashboardOverviewDaily.js";
import { buildFlowsOverviewPayload } from "../src/flowsOverview.js";
import { warmRentabilidadDailySeries } from "../src/rentabilidadDailyWarm.js";
import { coreCurrencyCodes } from "../src/displayUnits.js";

const HOME_OVERVIEW_DEFAULT_DAYS = 1096;
const top = Number(process.argv.find((a) => a.startsWith("--top="))?.slice(6) ?? 30);
const mb = (n: number) => (n / 1_048_576).toFixed(1);
const gc = (globalThis as { gc?: () => void }).gc;

function report(label: string): void {
  gc?.();
  const m = process.memoryUsage();
  console.log(`${label.padEnd(28)} heap ${mb(m.heapUsed).padStart(6)} MB   rss ${mb(m.rss).padStart(6)} MB`);
}

const replacer = (_k: string, x: unknown) => (x instanceof Map ? [...x] : x);
function approxBytes(v: unknown): { bytes: number; entries: number } {
  if (v instanceof Map) {
    let n = 0;
    let sampled = 0;
    let bytes = 0;
    for (const [k, val] of v) {
      n += 1;
      if (sampled < 50) {
        sampled += 1;
        bytes += (JSON.stringify(k)?.length ?? 0) + (JSON.stringify(val, replacer)?.length ?? 8);
      }
    }
    return { bytes: sampled ? Math.round((bytes / sampled) * n) : 0, entries: n };
  }
  return { bytes: JSON.stringify(v, replacer)?.length ?? 0, entries: 1 };
}

async function main(): Promise<void> {
  if (!gc) console.log("(run with --expose-gc for retained sizes; without it the figures include garbage)");
  report("boot");
  const units = coreCurrencyCodes();
  for (const unit of units) {
    await buildDashboardPageBundle(unit);
    report(`after page bundle ${unit}`);
  }
  for (const unit of units) getDashboardOverviewDaily(unit, HOME_OVERVIEW_DEFAULT_DAYS);
  report(`after overview daily ×${units.length}`);
  for (const unit of units) buildFlowsOverviewPayload(unit, "split", null);
  report(`after flows overview ×${units.length}`);
  const scopes = await warmRentabilidadDailySeries();
  report(`after ${scopes} Rentabilidad scopes`);

  const rows: { key: string; bytes: number; entries: number }[] = [];
  for (const key of aggregationCacheKeysForTest()) {
    let v = getAggregationCached<unknown>(key, () => undefined);
    if (v && typeof (v as Promise<unknown>).then === "function") v = await (v as Promise<unknown>);
    rows.push({ key, ...approxBytes(v) });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  console.log(`\n${rows.length} cache keys, ~${mb(total)} MB of JSON; the ${top} largest:`);
  for (const r of rows.slice(0, top)) {
    console.log(`${mb(r.bytes).padStart(7)} MB  ${String(r.entries).padStart(7)} entries  ${r.key.slice(0, 110)}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
