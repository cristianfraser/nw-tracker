/**
 * Performance proof for the valuation core steps 2–3 (docs/untangle-valuation-core.md): the
 * payloads value and P/L feed, in pesos, dollars and UF — every account's monthly rows, detail
 * bundle and 400-day daily series with perf levels; every group's period returns, valuation series
 * and 400-day daily series; the flows overview and deposits page; the card ledgers; the
 * inversiones day combo; every benchmark row. Each figure is computed in-process.
 *
 *   npx tsx scripts/dump-valuation-perf.ts --db=/abs/copy.db --out=/abs/out.json [--at=2026-11-07T18:00]
 *
 * Works on a COPY (it is migrated on open): refuses `server/data/nw-tracker.db`. The clock is
 * pinned to `--at` (Chile wall time). Output is personal data: keep it outside the repository.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dbArg = arg("db");
const outArg = arg("out");
if (!dbArg || !outArg) throw new Error("--db=/abs/copy.db and --out=/abs/out.json are required");
const source = path.resolve(dbArg);
if (path.basename(source) === "nw-tracker.db") throw new Error("refusing to run on the live DB; pass a copy");

const RealDate = Date;
const target = RealDate.parse(`${arg("at") ?? "2026-11-07T18:00"}:00-03:00`);
const offset = target - RealDate.now();
class PinnedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(RealDate.now() + offset);
    else super(...(a as [string]));
  }
  static now(): number {
    return RealDate.now() + offset;
  }
}
(globalThis as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;

process.env.NW_TRACKER_TEST_DB = source;
process.env.BACKGROUND_JOBS_ENABLED = "0";
process.env.CACHE_WARM_ENABLED = "0";
process.env.USAGE_LOG_ENABLED = "0";

const { db } = await import("../src/db.js");
const { coreCurrencyCodes } = await import("../src/displayUnits.js");
const { monthlyPerfForAccountDisplay } = await import("../src/detalleDailyChainedPct.js");
const { buildAccountDetailBundle } = await import("../src/accountDetailBundle.js");
const { accountDailySeriesResponse, groupDailySeriesResponse } = await import("../src/groupDailySeriesResponse.js");
const { getGroupPeriodReturns } = await import("../src/groupConsolidatedTables.js");
const { getGroupValuationTimeseries } = await import("../src/valuationTimeseries.js");
const { buildFlowsOverviewPayload } = await import("../src/flowsOverview.js");
const { buildFlowsDepositsPayload } = await import("../src/flowsDeposits.js");
const { creditCardInstallmentsResponse } = await import("../src/creditCardInstallments.js");
const { creditCardGroupLedgerResponse } = await import("../src/creditCardGroupLedger.js");
const { buildInversionesPerfDaily } = await import("../src/inversionesPerfSeries.js");
const { listBenchmarks } = await import("../src/benchmarkLevels.js");
const { benchmarkComparisonForAccount, benchmarkComparisonForGroup } = await import("../src/benchmarkComparison.js");
const { groupHasPeriodReturns } = await import("../src/portfolioGroupTree.js");

async function attempt<T>(f: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const UNITS = [...coreCurrencyCodes(), "uf"];
const DAYS = 400;
const accounts = db
  .prepare(
    `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
     FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
  )
  .all() as { account_id: number; name: string; bucket_slug: string; import_key: string | null }[];
const groups = (db.prepare(`SELECT slug FROM portfolio_groups ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug);
const liabilityGroups = (db.prepare(`SELECT slug FROM liability_groups ORDER BY slug`).all() as { slug: string }[]).map(
  (r) => r.slug
);
const cards = (
  db
    .prepare(
      `SELECT a.id FROM accounts a JOIN credit_card_account_config c ON c.account_id = a.id ORDER BY a.id`
    )
    .all() as { id: number }[]
).map((r) => r.id);
const benchmarks = listBenchmarks();

const out: Record<string, unknown> = { at: new RealDate(target).toISOString() };
const acc: Record<string, unknown> = {};
for (const a of accounts) {
  const perUnit: Record<string, unknown> = {};
  for (const unit of UNITS) {
    perUnit[unit] = {
      monthly: await attempt(() => monthlyPerfForAccountDisplay(a.account_id, unit)),
      bundle: await attempt(() => buildAccountDetailBundle(a.account_id, unit, "monthly")),
      daily: await attempt(() => accountDailySeriesResponse(a, unit, DAYS, true)),
      benchmarks:
        unit === "uf"
          ? null
          : Object.fromEntries(
              await Promise.all(
                benchmarks.map(async (b) => [b.slug, await attempt(() => benchmarkComparisonForAccount(a.account_id, b, unit))])
              )
            ),
    };
  }
  acc[a.account_id] = perUnit;
  process.stderr.write(`account ${a.account_id}\n`);
}
out.accounts = acc;

const grp: Record<string, unknown> = {};
for (const g of [...groups, ...liabilityGroups]) {
  const perUnit: Record<string, unknown> = {};
  for (const unit of UNITS) {
    perUnit[unit] = {
      returns: await attempt(() => getGroupPeriodReturns(g, unit)),
      valuation: await attempt(() => getGroupValuationTimeseries(g, unit, undefined, { groupedBlocks: true })),
      daily: await attempt(() => groupDailySeriesResponse(g, unit, DAYS, true)),
      benchmarks:
        unit === "uf" || !groupHasPeriodReturns(g)
          ? null
          : Object.fromEntries(
              await Promise.all(benchmarks.map(async (b) => [b.slug, await attempt(() => benchmarkComparisonForGroup(g, b, unit))]))
            ),
    };
  }
  grp[g] = perUnit;
  process.stderr.write(`group ${g}\n`);
}
out.groups = grp;

const flows: Record<string, unknown> = {};
for (const unit of coreCurrencyCodes()) {
  for (const mode of ["split", "total"] as const) {
    flows[`overview|${unit}|${mode}`] = await attempt(() => buildFlowsOverviewPayload(unit, mode, 400));
  }
}
flows.deposits = await attempt(() => buildFlowsDepositsPayload());
out.flows = flows;
out.cards = Object.fromEntries(await Promise.all(cards.map(async (id) => [id, await attempt(() => creditCardInstallmentsResponse(id))])));
out.cardGroups = Object.fromEntries(
  await Promise.all(liabilityGroups.map(async (g) => [g, await attempt(() => creditCardGroupLedgerResponse(g))]))
);
out.inversiones = Object.fromEntries(
  await Promise.all(UNITS.map(async (u) => [u, await attempt(() => buildInversionesPerfDaily(u, DAYS))]))
);

writeFileSync(outArg, JSON.stringify(out, null, 1));
console.log(`wrote ${outArg}`);
process.exit(0);
