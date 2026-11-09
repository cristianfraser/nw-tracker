import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { closingByCalendarMonthFromRaw } from "./accountPerformance.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { db } from "./db.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";
import {
  getDashboardValuationTimeseries,
  liabilitiesBreakdownClpAsOf,
  listAccountsForGroupTab,
  listLiabilitiesTabAccountRows,
} from "./valuationTimeseries.js";
import { portfolioGroupApiForValuation } from "./portfolioGroupReference.js";

function liabilitiesTotalClpAsOf(asOfYmd: string): number {
  const parts = liabilitiesBreakdownClpAsOf(asOfYmd);
  return parts.mortgage_clp + parts.credit_card_clp;
}

describe("listLiabilitiesTabAccountRows", () => {
  it("CC tab rows use master accounts (one id for Gastos and Pasivos)", () => {
    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    if (!ccRows.length) return;
    for (const r of ccRows) {
      expect(String(r.import_key ?? "")).toMatch(/^credit_card_master\|/);
    }
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
    expect(liabilitiesTotalClpAsOf(row.as_of_date)).toBeCloseTo(
      tabSum,
      0
    );
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
    const breakdown = liabilitiesBreakdownClpAsOf(asOf);
    const breakdownTotal = breakdown.mortgage_clp + breakdown.credit_card_clp;
    const ovLiab = lastOv.liabilities;
    if (typeof ovLiab !== "number" || !Number.isFinite(ovLiab)) return;
    expect(ovLiab).toBeCloseTo(breakdownTotal, 0);
  });

  it("returns at most one row per operational credit card series", () => {
    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    if (ccRows.length < 2) return;
    const seriesIds = ccRows.map((r) => r.account_id);
    expect(new Set(seriesIds).size).toBe(seriesIds.length);
  });
});
