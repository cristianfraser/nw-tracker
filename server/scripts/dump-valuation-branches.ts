/**
 * Branch proof for the valuation core (docs/untangle-valuation-core.md): for every account and a
 * set of dates — ten month-ends spread over the history, yesterday and today — which branch each
 * value ladder takes and the value in pesos and dollars; with `--payloads`, the page payloads the
 * valuation feeds (home bundle in both units, every group page, the 90-day daily series of net
 * worth and its buckets, the liabilities pages), fetched from an in-process server.
 *
 *   npx tsx scripts/dump-valuation-branches.ts --db=/abs/copy.db --out=/abs/out.json [--payloads] [--at=2026-11-07T18:00]
 *
 * Works on a COPY (it is migrated on open): refuses `server/data/nw-tracker.db`. The clock is
 * pinned to `--at` (Chile wall time, default 2026-11-07T18:00) so two runs read the same today.
 * Output is personal data: keep it outside the repository.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dbArg = arg("db");
const outArg = arg("out");
if (!dbArg || !outArg) throw new Error("--db=/abs/copy.db and --out=/abs/out.json are required");
const source = path.resolve(dbArg);
if (path.basename(source) === "nw-tracker.db") throw new Error("refusing to run on the live DB; pass a copy");
const withPayloads = process.argv.includes("--payloads");

// --- Pin the clock before anything reads it (Chile is UTC−3 in November).
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
process.env.PORT = process.env.PORT ?? "3988";
process.env.HOST = "127.0.0.1";

const { db } = await import("../src/db.js");
const { chileCalendarTodayYmd, chileCalendarAddDays } = await import("../src/chileDate.js");
const { accountValueAt } = await import("../src/accountValue.js");
const { accountTodayValue } = await import("../src/accountTodayValue.js");
const { accountMarkClpAtYmd, accountHistoricalQtyMark } = await import("../src/accountMarkClpAtYmd.js");
const { accountHolding } = await import("../src/holdings.js");
const profileMod = await import("../src/accountProfile.js").catch(() => null);

const today = chileCalendarTodayYmd();
const yesterday = chileCalendarAddDays(today, -1);

function attempt<T>(f: () => T): T | { error: string } {
  try {
    return f();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ten month-ends spread evenly from the first movement or valuation to last month. */
function monthEnds(): string[] {
  const first = db
    .prepare(
      `SELECT MIN(d) AS d FROM (SELECT MIN(occurred_on) AS d FROM movements UNION ALL SELECT MIN(as_of_date) FROM valuations)`
    )
    .get() as { d: string };
  const ends: string[] = [];
  let y = Number(first.d.slice(0, 4));
  let m = Number(first.d.slice(5, 7));
  const lastYm = today.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym >= lastYm) break;
    const lastDay = new RealDate(RealDate.UTC(y, m, 0)).getUTCDate();
    ends.push(`${ym}-${String(lastDay).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const out: string[] = [];
  for (let i = 0; i < 10; i++) out.push(ends[Math.round((i * (ends.length - 1)) / 9)]!);
  return [...new Set(out)];
}

const dates = [...monthEnds(), yesterday, today];
const accounts = db
  .prepare(`SELECT a.id, g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`)
  .all() as { id: number; slug: string }[];

const perAccount: Record<string, unknown> = {};
for (const a of accounts) {
  const values: Record<string, unknown> = {};
  for (const d of dates) {
    values[d] = {
      clp: attempt(() => accountValueAt(a.id, d, "clp")),
      usd: attempt(() => accountValueAt(a.id, d, "usd")),
      mark: attempt(() => accountMarkClpAtYmd(a.id, d)),
      qty: d < today ? attempt(() => accountHistoricalQtyMark(a.id, d)) : null,
    };
  }
  perAccount[a.id] = {
    slug: a.slug,
    holding: attempt(() => accountHolding(a.id)),
    branch: profileMod ? attempt(() => profileMod.accountProfile(a.id).quantity.kind) : null,
    today: attempt(() => accountTodayValue(a.id)),
    values,
  };
}

const out: Record<string, unknown> = { at: new RealDate(target).toISOString(), today, dates, accounts: perAccount };

if (withPayloads) {
  await import("../src/index.js");
  await new Promise((r) => setTimeout(r, 500));
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const groups = (
    db.prepare(`SELECT slug FROM portfolio_groups ORDER BY slug`).all() as { slug: string }[]
  ).map((r) => r.slug);
  const liabilityGroups = (
    db.prepare(`SELECT slug FROM liability_groups ORDER BY slug`).all() as { slug: string }[]
  ).map((r) => r.slug);
  const navBuckets = (
    db
      .prepare(`SELECT slug FROM portfolio_groups WHERE parent_id = (SELECT id FROM portfolio_groups WHERE slug = 'net_worth')`)
      .all() as { slug: string }[]
  ).map((r) => r.slug);
  const paths: string[] = [];
  for (const unit of ["clp", "usd"]) {
    paths.push(`/api/dashboard/page-bundle?unit=${unit}`);
    paths.push(`/api/accounts?unit=${unit}`);
  }
  for (const g of [...groups, ...liabilityGroups]) {
    paths.push(`/api/dashboard/valuation-timeseries?portfolio_group=${g}`);
    paths.push(`/api/groups/${g}/consolidated-tables`);
    paths.push(`/api/groups/${g}/performance-monthly`);
    paths.push(`/api/dashboard/nav-context?root=${g}`);
  }
  for (const g of ["net_worth", ...navBuckets, "liabilities"]) {
    paths.push(`/api/daily-series?portfolio_group=${g}&days=90`);
  }
  paths.push(`/api/portfolio-groups/liabilities/cc-ledger`);
  paths.push(`/api/portfolio-groups/liabilities/mortgage-ledger`);
  for (const a of accounts) paths.push(`/api/accounts/${a.id}/detail-bundle`);
  const payloads: Record<string, unknown> = {};
  for (const p of paths) {
    const res = await fetch(base + p);
    const text = await res.text();
    payloads[p] = res.ok ? JSON.parse(text) : { status: res.status, body: text.slice(0, 300) };
  }
  out.payloads = payloads;
}

writeFileSync(outArg, JSON.stringify(out, null, 1));
console.log(`wrote ${outArg}: ${accounts.length} accounts × ${dates.length} dates${withPayloads ? ", payloads" : ""}`);
process.exit(0);
