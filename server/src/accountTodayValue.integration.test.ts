import { describe, expect, it } from "vitest";
import { accountTodayValue } from "./accountTodayValue.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { isLiabilityAccountId } from "./accountBucket.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { NW_DASHBOARD_BUCKET_SLUGS } from "./portfolioGroupValueAtDate.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { clpToUnitAt } from "./clpToUnitAt.js";
import { getDashboardOverviewBlock } from "./valuationTimeseries.js";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";

/**
 * One figure for an account's value today (CLP): the dashboard row, the today mark, the current
 * month's performance close and the account chart's last point all read `accountTodayValue`.
 */
describe("accountTodayValue — one figure per account today (CLP)", () => {
  it("dashboard row == today mark == current-month perf close == account chart today point", async () => {
    const today = chileCalendarTodayYmd();
    const rows = await buildDashboardAccountRows(false);
    const mismatches: string[] = [];
    let checked = 0;
    for (const r of rows) {
      const tv = accountTodayValue(r.account_id, r.bucket_slug);
      if (tv == null) continue;
      checked += 1;
      const close = (label: string, got: number | null | undefined) => {
        if (got == null || Math.abs(got - tv.value_clp) > 0.5) {
          mismatches.push(`${r.account_id} ${r.name} ${label}: ${got} vs ${tv.value_clp}`);
        }
      };
      close("dashboard row", r.current_value_clp);
      close("today mark", accountMarkClpAtYmd(r.account_id, today, r.bucket_slug)?.value_clp);

      const perf = monthlyPerfRowsForAccount(r.account_id, r.bucket_slug, "clp");
      const cur = perf.find((p) => monthKeyFromYmd(p.as_of_date) === monthKeyFromYmd(today));
      if (cur != null && r.dashboard_bucket_slug != null) close("perf close", cur.closing_value);

      // The live point: today's when the chart has one (a card's, inserted before its
      // projected month-ends), else the latest (the monthly grid's current month-end).
      const points = getAccountValuationTimeseries(r.account_id, "clp")?.accounts.points ?? [];
      const livePoint = points.find((p) => p.as_of_date === today) ?? points[points.length - 1];
      const plotted = livePoint?.[String(r.account_id)];
      // A null point is a sold-out line the tail clip ended.
      if (typeof plotted === "number") close("chart live point", plotted);
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});

/**
 * The same figure in USD: the dashboard row frames each account's pesos on the day they were
 * priced (`clpToUnitAt` / `accountValueClpToUnitAt`, a USD cash account's ledger dollars), and
 * the current month's performance close and the account chart's live point read the same
 * helper; the home bucket cards are Σ of their members' dollars and the headline Σ of the cards.
 */
describe("accountTodayValue — one figure per account today (USD)", () => {
  const TOL_USD = 0.01;

  it("dashboard row == current-month perf close == account chart live point, every asset account", async () => {
    const today = chileCalendarTodayYmd();
    const rows = await buildDashboardAccountRows(true);
    const mismatches: string[] = [];
    let checked = 0;
    for (const r of rows) {
      if (isLiabilityAccountId(r.account_id)) continue;
      const usd = r.current_value_usd;
      if (usd == null) continue;
      checked += 1;
      const close = (label: string, got: number | null | undefined) => {
        if (got == null || Math.abs(got - usd) > TOL_USD) {
          mismatches.push(`${r.account_id} ${r.name} ${label}: ${got} vs ${usd}`);
        }
      };
      const perf = monthlyPerfRowsForAccount(r.account_id, r.bucket_slug, "usd");
      const cur = perf.find((p) => monthKeyFromYmd(p.as_of_date) === monthKeyFromYmd(today));
      if (cur != null && r.dashboard_bucket_slug != null) close("perf close", cur.closing_value);

      const points = getAccountValuationTimeseries(r.account_id, "usd")?.accounts.points ?? [];
      const livePoint = points.find((p) => p.as_of_date === today) ?? points[points.length - 1];
      const plotted = livePoint?.[String(r.account_id)];
      if (typeof plotted === "number") close("chart live point", plotted);
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it("Σ home bucket cards == headline == Σ dashboard rows per bucket (cash net of linked cards)", async () => {
    const today = chileCalendarTodayYmd();
    const rows = await buildDashboardAccountRows(true);
    const totals = buildDashboardNwBucketTotals(true);
    const cardUsd: Record<string, number | null | undefined> = {
      real_estate: totals.real_estate_usd,
      retirement: totals.retirement_usd,
      brokerage: totals.brokerage_usd,
      cash_eqs: totals.cash_eqs_usd,
    };
    let sumCards = 0;
    const mismatches: string[] = [];
    for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
      const card = cardUsd[slug];
      expect(card, `${slug} card USD`).not.toBeNull();
      sumCards += card!;
      let sumRows = 0;
      for (const r of rows) {
        if (r.dashboard_bucket_slug !== slug || r.exclude_from_group_totals === 1) continue;
        sumRows += r.current_value_usd ?? 0;
      }
      if (slug === "cash_eqs") {
        const cc = linkedCreditCardClpForCashCardAsOf(today);
        sumRows -= cc === 0 ? 0 : clpToUnitAt(cc, today, "usd")!;
      }
      if (Math.abs(sumRows - card!) > TOL_USD) mismatches.push(`${slug}: rows ${sumRows} vs card ${card}`);
    }
    expect(mismatches).toEqual([]);
    expect(Math.abs(sumCards - (totals.net_worth_usd ?? Number.NaN))).toBeLessThanOrEqual(TOL_USD);
  });
  it("the overview charts' today point in USD == the headline (monthly and daily)", () => {
    const today = chileCalendarTodayYmd();
    const totals = buildDashboardNwBucketTotals(true);
    const expected: Record<string, number | null | undefined> = {
      total_nw: totals.net_worth_usd,
      retirement: totals.retirement_usd,
      brokerage: totals.brokerage_usd,
      cash: totals.cash_eqs_usd,
    };
    const monthly = getDashboardOverviewBlock("usd").points.find((p) => p.as_of_date === today);
    expect(monthly, "monthly overview has a today point").toBeDefined();
    const daily = getDashboardOverviewDaily("usd", 30).points.find((p) => p.as_of_date === today);
    expect(daily, "daily overview has a today point").toBeDefined();
    const dailyKey: Record<string, string> = { total_nw: "net_worth", retirement: "retirement", brokerage: "brokerage", cash: "cash_eqs" };
    const mismatches: string[] = [];
    for (const [key, want] of Object.entries(expected)) {
      expect(want, `${key} headline USD`).not.toBeNull();
      const m = monthly![key];
      const d = (daily as Record<string, unknown>)[dailyKey[key]!];
      if (typeof m !== "number" || Math.abs(m - want!) > TOL_USD) mismatches.push(`monthly ${key}: ${m} vs ${want}`);
      if (typeof d !== "number" || Math.abs(d - want!) > TOL_USD) mismatches.push(`daily ${key}: ${d} vs ${want}`);
    }
    expect(mismatches).toEqual([]);
  });
});
