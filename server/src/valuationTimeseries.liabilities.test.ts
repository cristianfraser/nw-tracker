import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";
import {
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  liabilitiesBreakdownClpAsOf,
  listLiabilitiesTabAccountRows,
  seriesAccountIdForGroupTab,
} from "./valuationTimeseries.js";

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
        r.category_slug,
        row.as_of_date
      );
      if (snap?.value_clp != null && Number.isFinite(snap.value_clp)) tabSum += snap.value_clp;
    }
    expect(liabilitiesTotalClpAsOf(row.as_of_date, { mortgageFromDeptoSheet: true })).toBeCloseTo(
      tabSum,
      0
    );
  });

  it("overview Pasivos line matches Pasivos class-tab total at the same as-of date", () => {
    const tsDash = getDashboardValuationTimeseries("clp");
    const tsLiab = getGroupValuationTimeseries("liabilities", "clp");
    const ovPoints = tsDash.overview?.points ?? [];
    const liabPoints = tsLiab.accounts_in_group?.points ?? [];
    if (ovPoints.length === 0 || liabPoints.length === 0) return;

    const lastOv = ovPoints[ovPoints.length - 1]!;
    const asOf = String(lastOv.as_of_date);
    const liabPt = liabPoints.find((p) => String(p.as_of_date) === asOf);
    if (!liabPt) return;

    const tabTotal = liabPt.__group_val_total;
    let tabSum = 0;
    if (typeof tabTotal === "number" && Number.isFinite(tabTotal)) {
      tabSum = tabTotal;
    } else {
      for (const a of tsLiab.accounts_in_group?.accounts ?? []) {
        if (a.account_id <= 0) continue;
        const v = liabPt[a.dataKey];
        if (typeof v === "number" && Number.isFinite(v)) tabSum += v;
      }
    }
    const ovLiab = lastOv.liabilities;
    if (typeof ovLiab !== "number" || !Number.isFinite(ovLiab)) return;
    expect(ovLiab).toBeCloseTo(tabSum, 0);
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
      const snap = latestLiabilityValuationRowForSnapshot(r.account_id, r.category_slug, today);
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
