/**
 * Step-3 measurement (docs/untangle-valuation-core.md): for every account, how far Σ of its day
 * P/L over a calendar month (its own daily series, full history) is from that month's row
 * (`monthlyPerfRowsForAccount`, the row every table and card reads). Prints, per account, the
 * months compared and the max / mean |difference| in pesos — counts and magnitudes only.
 *
 *   npx tsx scripts/measure-day-vs-month-pl.ts --db=/abs/copy.db [--at=2026-11-07T18:00]
 *
 * Works on a COPY (migrated on open): refuses `server/data/nw-tracker.db`.
 */
import path from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dbArg = arg("db");
if (!dbArg) throw new Error("--db=/abs/copy.db is required");
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
const { resolveAccountDailySeries } = await import("../src/groupDailySeries.js");
const { monthlyPerfRowsForAccount } = await import("../src/groupMonthlyPerfConsolidation.js");
const { pickMonthlyPerfRowsByMonth } = await import("../src/accountPeriodMetrics.js");
const { accountProfileOptional } = await import("../src/accountProfile.js");

const accounts = db
  .prepare(
    `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
     FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
  )
  .all() as { account_id: number; name: string; bucket_slug: string; import_key: string | null }[];

const lines: string[] = [];
let n = 0;
for (const a of accounts) {
  const kind = accountProfileOptional(a.account_id)?.quantity.kind ?? "?";
  const months = pickMonthlyPerfRowsByMonth(monthlyPerfRowsForAccount(a.account_id, a.bucket_slug, "clp"));
  if (months.size === 0) continue;
  const series = resolveAccountDailySeries(a, "clp", 0);
  const dayPlByMonth = new Map<string, number>();
  for (const p of series.points) {
    if (p.pl == null) continue;
    const mk = p.as_of_date.slice(0, 7);
    dayPlByMonth.set(mk, (dayPlByMonth.get(mk) ?? 0) + p.pl);
  }
  let compared = 0;
  let max = 0;
  let sum = 0;
  let nonZero = 0;
  for (const [mk, row] of months) {
    if (row.nominal_pl == null || !dayPlByMonth.has(mk)) continue;
    const d = Math.abs(dayPlByMonth.get(mk)! - row.nominal_pl);
    compared += 1;
    sum += d;
    if (d > 0.5) nonZero += 1;
    if (d > max) max = d;
  }
  n += 1;
  lines.push(
    `account#${String(n).padStart(2, "0")} ${kind.padEnd(16)} months ${String(compared).padStart(4)}  off>1peso ${String(nonZero).padStart(4)}  max ${Math.round(max).toString().padStart(12)}  mean ${Math.round(compared ? sum / compared : 0).toString().padStart(10)}`
  );
}
console.log(lines.join("\n"));
process.exit(0);
