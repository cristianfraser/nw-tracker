import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import type { ShortHorizonAccountRef } from "./periodReturnsShortHorizon.js";

/**
 * A daily series and a month of performance in euros are the peso figures converted per day /
 * per event (`docs/any-currency-plan.md`, Stream 3). The fixture is the synthetic test person's
 * peso cuenta corriente (no dollar leg, so EUR/CLP — a direct pair, no spread — is the only
 * rate involved) and a synthetic `eur_daily` series that moves every day, inserted for the
 * test and removed after it.
 */

const insertedDates: string[] = [];
let account: ShortHorizonAccountRef | null = null;

function eurRate(ymd: string): number {
  // A distinct rate per day: 1.000 ± a few pesos, deterministic.
  const n = Number(ymd.replaceAll("-", ""));
  return 1000 + (n % 37) - 18;
}

function addDaysYmd(ymd: string, d: number): string {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

// The synthetic market writes EUR rates; this test states its own series, so it empties both
// EUR tables first and puts them back after.
const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  const row = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'cash_eqs__cuenta_corriente'
       ORDER BY (SELECT COUNT(*) FROM movements m WHERE m.account_id = a.id OR m.from_account_id = a.id OR m.to_account_id = a.id) DESC
       LIMIT 1`
    )
    .get() as ShortHorizonAccountRef | undefined;
  if (!row) return;
  account = row;
  const today = chileCalendarTodayYmd();
  const first = (db.prepare(`SELECT MIN(occurred_on) AS d FROM movements`).get() as { d: string | null }).d;
  const start = addDaysYmd(first ?? addDaysYmd(today, -400), -40);
  const ins = db.prepare(`INSERT OR IGNORE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`);
  db.transaction(() => {
    for (let d = start; d <= today; d = addDaysYmd(d, 1)) {
      if (ins.run(d, eurRate(d)).changes > 0) insertedDates.push(d);
    }
  })();
  clearAggregationCache();
});

afterAll(() => {
  restoreEurTables();
  clearAggregationCache();
});

describe("display unit EUR (peso account)", () => {
  it("daily series: each day's value and flow is the peso figure at that day's EUR/CLP", () => {
    expect(account).not.toBeNull();
    expect(insertedDates.length).toBeGreaterThan(0);
    if (!account) return;
    const clp = getBucketDailySeries([account], { unit: "clp", days: 120 });
    const eur = getBucketDailySeries([account], { unit: "eur", days: 120 });
    expect(eur.unit).toBe("eur");
    expect(eur.points.map((p) => p.as_of_date)).toEqual(clp.points.map((p) => p.as_of_date));
    let flows = 0;
    clp.points.forEach((pc, i) => {
      const pe = eur.points[i]!;
      const r = eurRate(pc.as_of_date);
      if (pc.value == null) {
        expect(pe.value).toBeNull();
      } else {
        expect(pe.value!).toBeCloseTo(pc.value / r, 6);
      }
      expect(pe.flow).toBeCloseTo(pc.flow / r, 6);
      if (pc.flow !== 0) flows++;
    });
    expect(flows).toBeGreaterThan(0);
  });

  it("monthly performance: closing at the month-end rate, flows at each event's rate", () => {
    expect(account).not.toBeNull();
    if (!account) return;
    const clp = monthlyPerfForAccountId(account.account_id, "clp")!;
    const eur = monthlyPerfForAccountId(account.account_id, "eur")!;
    expect(eur.monthly.length).toBe(clp.monthly.length);
    const today = chileCalendarTodayYmd();
    let checked = 0;
    clp.monthly.forEach((mc, i) => {
      const me = eur.monthly[i]!;
      expect(me.as_of_date).toBe(mc.as_of_date);
      if (mc.closing_value == null) return;
      // The month-end close (today for the month in progress) at that day's rate.
      const closeDay = mc.as_of_date > today ? today : mc.as_of_date;
      expect(me.closing_value!).toBeCloseTo(mc.closing_value / eurRate(closeDay), 4);
      checked++;
    });
    expect(checked).toBeGreaterThan(0);
    // Flows are converted per event: a month with a single event day converts at that day.
    const sumClp = clp.monthly.reduce((s, m) => s + (m.net_capital_flow ?? 0), 0);
    const sumEur = eur.monthly.reduce((s, m) => s + (m.net_capital_flow ?? 0), 0);
    const ratio = sumClp === 0 ? 0 : sumEur / sumClp;
    expect(Math.abs(ratio)).toBeGreaterThan(1 / 1100);
    expect(Math.abs(ratio)).toBeLessThan(1 / 950);
  });
});
