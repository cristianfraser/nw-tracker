import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { closingByCalendarMonthFromRaw } from "./accountPerformance.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { db } from "./db.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";
import { listFirstLevelPortfolioGroupChildren } from "./portfolioGroups.js";
import {
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  liabilitiesBreakdownClpAsOf,
  listAccountsForGroupTab,
  listLiabilitiesTabAccountRows,
  seriesAccountIdForGroupTab,
} from "./valuationTimeseries.js";
import { portfolioGroupApiForValuation } from "./portfolioGroupReference.js";

function liabilitiesTotalClpAsOf(
  asOfYmd: string,
  opts?: { mortgageFromDeptoSheet?: boolean }
): number {
  const parts = liabilitiesBreakdownClpAsOf(asOfYmd, opts);
  return parts.mortgage_clp + parts.credit_card_clp;
}

describe("listLiabilitiesTabAccountRows", () => {
  it("excludes legacy combined worldmember when per-card Santander masters exist", () => {
    const perCard = db
      .prepare(`SELECT 1 AS o FROM accounts WHERE notes LIKE 'credit_card_master|santander|%' LIMIT 1`)
      .get() as { o: number } | undefined;
    if (!perCard) return;

    const legacyMaster = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=credit_card' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!legacyMaster) return;

    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    const seriesIds = new Set(
      ccRows.map((r) => {
        const src = db
          .prepare(`SELECT source_account_id FROM accounts WHERE id = ?`)
          .get(r.account_id) as { source_account_id: number | null } | undefined;
        return src?.source_account_id ?? r.account_id;
      })
    );
    expect(seriesIds.has(legacyMaster.id)).toBe(false);
    expect(ccRows.length).toBeGreaterThan(0);
  });

  it("includes mortgage liability_view for hipoteca tab", () => {
    const mtgRows = listLiabilitiesTabAccountRows("mortgage");
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;
    expect(mtgRows.length).toBeGreaterThan(0);
    const view = db
      .prepare(
        `SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`
      )
      .get(master.id) as { id: number } | undefined;
    if (!view) return;
    expect(mtgRows.some((r) => r.account_id === view.id)).toBe(true);
  });

  it("breakdown total matches sum of Pasivos tab account rows at a snapshot date", () => {
    const row = db
      .prepare(`SELECT as_of_date FROM valuations ORDER BY as_of_date DESC LIMIT 1`)
      .get() as { as_of_date: string } | undefined;
    if (!row) return;

    const tabRows = listLiabilitiesTabAccountRows();
    let tabSum = 0;
    for (const r of tabRows) {
      const snap = latestLiabilityValuationRowForSnapshot(
        r.account_id,
        accountBucketKindSlug(r.bucket_slug),
        row.as_of_date
      );
      if (snap?.value_clp != null && Number.isFinite(snap.value_clp)) tabSum += snap.value_clp;
    }
    expect(liabilitiesTotalClpAsOf(row.as_of_date, { mortgageFromDeptoSheet: true })).toBeCloseTo(
      tabSum,
      0
    );
  });

  it("primary chart lines match brokerage and retirement first-level portfolio children", () => {
    const ts = getDashboardValuationTimeseries("clp");
    const accounts = ts.accounts_ex_property?.accounts ?? [];
    const expectedSlugs = [
      ...listFirstLevelPortfolioGroupChildren("brokerage").map((c) => c.slug),
      ...listFirstLevelPortfolioGroupChildren("retirement").map((c) => c.slug),
      "cash_eqs",
    ];
    expect(expectedSlugs.length).toBeGreaterThanOrEqual(6);
    expect(accounts.length).toBe(expectedSlugs.length);
    const labels = new Set(accounts.map((a) => a.name));
    for (const child of [
      ...listFirstLevelPortfolioGroupChildren("brokerage"),
      ...listFirstLevelPortfolioGroupChildren("retirement"),
    ]) {
      expect(labels.has(child.label)).toBe(true);
    }
  });

  it("overview brokerage on a mid-month chart date uses that month's cierre, not prior month", () => {
    const tsDash = getDashboardValuationTimeseries("clp");
    const ovPoints = tsDash.overview?.points ?? [];
    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const midMonthPoint = ovPoints.find((p) => {
      const d = String(p.as_of_date);
      return monthKeyFromYmd(d) === curMk && d < today;
    });
    if (!midMonthPoint) return;

    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation("brokerage");
    const byMonth = closingByCalendarMonthFromRaw(
      consolidatedClosingRawByDate(
        getGroupConsolidatedMonthlyPerfForRows(
          listAccountsForGroupTab(groupSlug, tabSubgroup),
          groupSlug,
          "clp"
        )
      )
    );
    const curCierre = byMonth.get(curMk);
    const ovBro = midMonthPoint.brokerage;
    if (
      curCierre == null ||
      typeof ovBro !== "number" ||
      !Number.isFinite(ovBro) ||
      !Number.isFinite(curCierre)
    ) {
      return;
    }
    expect(ovBro).toBeCloseTo(curCierre, 0);
  });

  it("overview bucket lines match group monthly perf cierre on the last chart date", () => {
    const tsDash = getDashboardValuationTimeseries("clp");
    const ovPoints = tsDash.overview?.points ?? [];
    if (ovPoints.length === 0) return;

    const lastOv = ovPoints[ovPoints.length - 1]!;
    const asOf = String(lastOv.as_of_date);

    const closingAtChartDate = (portfolioSlug: string, chartDate: string): number | undefined => {
      const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(portfolioSlug);
      const byMonth = closingByCalendarMonthFromRaw(
        consolidatedClosingRawByDate(
          getGroupConsolidatedMonthlyPerfForRows(
            listAccountsForGroupTab(groupSlug, tabSubgroup),
            groupSlug,
            "clp"
          )
        )
      );
      const mk = monthKeyFromYmd(chartDate);
      const inMonth = byMonth.get(mk);
      if (inMonth != null && Number.isFinite(inMonth)) return inMonth;
      let last: number | undefined;
      for (const m of [...byMonth.keys()].sort()) {
        if (m > mk) break;
        const v = byMonth.get(m);
        if (v != null && Number.isFinite(v)) last = v;
      }
      return last;
    };

    const ovBro = lastOv.brokerage;
    const detalleBro = closingAtChartDate("brokerage", asOf);
    if (typeof ovBro !== "number" || !Number.isFinite(ovBro) || detalleBro == null) return;
    expect(ovBro).toBeCloseTo(detalleBro, 0);

    const ovRet = lastOv.retirement;
    const detalleRet = closingAtChartDate("retirement", asOf);
    if (typeof ovRet === "number" && Number.isFinite(ovRet) && detalleRet != null) {
      expect(ovRet).toBeCloseTo(detalleRet, 0);
    }
  });

  it("overview Pasivos line matches liabilities breakdown total at the same as-of date", () => {
    const tsDash = getDashboardValuationTimeseries("clp");
    const ovPoints = tsDash.overview?.points ?? [];
    if (ovPoints.length === 0) return;

    const lastOv = ovPoints[ovPoints.length - 1]!;
    const asOf = String(lastOv.as_of_date);
    const breakdown = liabilitiesBreakdownClpAsOf(asOf, { mortgageFromDeptoSheet: true });
    const breakdownTotal = breakdown.mortgage_clp + breakdown.credit_card_clp;
    const ovLiab = lastOv.liabilities;
    if (typeof ovLiab !== "number" || !Number.isFinite(ovLiab)) return;
    expect(ovLiab).toBeCloseTo(breakdownTotal, 0);
  });

  it("hipoteca tab chart point matches liabilities breakdown mortgage_clp at the same as-of date", () => {
    const mtgRows = listLiabilitiesTabAccountRows("mortgage");
    if (mtgRows.length === 0) return;

    const ts = getGroupValuationTimeseries("liabilities", "clp", "mortgage");
    const points = ts.accounts_in_group?.points ?? [];
    if (points.length === 0) return;

    const lastPt = points[points.length - 1]!;
    const asOf = String(lastPt.as_of_date);
    const breakdown = liabilitiesBreakdownClpAsOf(asOf, { mortgageFromDeptoSheet: true });
    if (breakdown.mortgage_clp <= 0) return;

    let chartSum = 0;
    for (const r of mtgRows) {
      const seriesId = seriesAccountIdForGroupTab(r, "liabilities");
      const dk = String(seriesId);
      const v = lastPt[dk];
      if (typeof v === "number" && Number.isFinite(v)) chartSum += v;
    }
    expect(chartSum).toBeCloseTo(breakdown.mortgage_clp, 0);
  });

  it("breakdown mortgage_clp at today matches sum of liability snapshots", () => {
    const today = chileCalendarTodayYmd();
    const breakdown = liabilitiesBreakdownClpAsOf(today, { mortgageFromDeptoSheet: true });
    if (breakdown.mortgage_clp <= 0) return;

    const mtgRows = listLiabilitiesTabAccountRows("mortgage");
    let snapSum = 0;
    for (const r of mtgRows) {
      const snap = latestLiabilityValuationRowForSnapshot(
        r.account_id,
        accountBucketKindSlug(r.bucket_slug),
        today
      );
      if (snap?.value_clp != null && Number.isFinite(snap.value_clp)) snapSum += snap.value_clp;
    }
    expect(snapSum).toBeCloseTo(breakdown.mortgage_clp, 0);
  });

  it("returns at most one row per operational credit card series", () => {
    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    if (ccRows.length < 2) return;
    const seriesIds: number[] = [];
    for (const r of ccRows) {
      const src = db
        .prepare(`SELECT source_account_id FROM accounts WHERE id = ?`)
        .get(r.account_id) as { source_account_id: number | null } | undefined;
      seriesIds.push(src?.source_account_id ?? r.account_id);
    }
    expect(new Set(seriesIds).size).toBe(seriesIds.length);
  });
});
