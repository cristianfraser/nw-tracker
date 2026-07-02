import { describe, expect, it } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountUsesEquityMtm, equityShareUnitsThroughYmd } from "./brokerageEquityMtm.js";
import { deptoAccountMarkClpAtYmd, deptoSueciaNetEquityUfBySnapshotDates } from "./deptoDividendosLedger.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  loadDeptoDividendosSheetLedgerFromDb,
  loadDeptoDividendosSheetLedgerFromFile,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoDividendosLedger.js";
import { deptoDividendosSheetRowCount } from "./deptoSheetDb.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { reconcileDashboardCardMetrics } from "./dashboardCardMetricsReconcile.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

function ensureDeptoSheetInDb(): void {
  if (deptoDividendosSheetRowCount() > 0) return;
  const fromFile = loadDeptoDividendosSheetLedgerFromFile(resolveCfraserCsvDir());
  if (fromFile.length > 0) replaceDeptoDividendosSheetRowsInDb(fromFile);
}

describe("deptoAccountMarkClpAtYmd", () => {
  it("property mark at two dates differs when UF rates differ", () => {
    ensureDeptoSheetInDb();
    const ledger = loadDeptoDividendosSheetLedgerFromDb();
    if (!ledger.length) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const may = deptoAccountMarkClpAtYmd("property", priorEnd);
    const now = deptoAccountMarkClpAtYmd("property", today);
    if (!may || !now) return;

    const ufMap = ufClpBySnapshotDatesAsc([priorEnd, today]);
    const ufPrior = ufMap.get(priorEnd);
    const ufNow = ufMap.get(today);
    if (ufPrior == null || ufNow == null || ufPrior === ufNow) return;

    const netUf = deptoSueciaNetEquityUfBySnapshotDates([priorEnd], ledger).get(priorEnd);
    if (netUf == null) return;

    expect(now.value_clp).not.toBe(may.value_clp);
    expect(now.value_clp - may.value_clp).toBeCloseTo(netUf * (ufNow - ufPrior), -2);
  });
});

describe("deptoKindForBucketSlug via accountMarkClpAtYmd", () => {
  it("resolves real_estate__property leaf slug to depto UF mark", () => {
    const today = chileCalendarTodayYmd();
    const depto = deptoAccountMarkClpAtYmd("property", today);
    const viaLeaf = accountMarkClpAtYmd(0, today, "real_estate__property");
    if (!depto || !viaLeaf) return;
    expect(viaLeaf.value_clp).toBe(depto.value_clp);
  });
});

describe("accountMarkClpAtYmd property", () => {
  it("today uses UF mark not stale valuations when sheet exists", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const deptoToday = deptoAccountMarkClpAtYmd("property", today);
    if (!deptoToday) return;

    const markToday = accountMarkClpAtYmd(row.id, today, "real_estate__property");
    const markPrior = accountMarkClpAtYmd(row.id, priorEnd, "property");
    expect(markToday?.value_clp).toBe(deptoToday.value_clp);
    expect(markPrior?.value_clp).toBeDefined();

    if (markPrior && markPrior.value_clp !== markToday.value_clp) {
      const delta = markToday!.value_clp - markPrior.value_clp;
      expect(Math.abs(delta)).toBeGreaterThan(0);
    }
  });

  it("suecia current-month perf nominal reflects UF move when prior month-end differs", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (cur?.nominal_pl == null) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const may = deptoAccountMarkClpAtYmd("property", priorEnd);
    const now = deptoAccountMarkClpAtYmd("property", today);
    if (!may || !now || may.value_clp === now.value_clp) return;

    expect(Math.abs(cur.nominal_pl ?? 0)).toBeGreaterThan(0);
  });

  it("current-month perf row is dated Chile today", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!cur) return;

    expect(cur.as_of_date).toBe(today);
  });

  it("reconciled dashboard MTD non-zero when UF moved", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.name, a.notes, g.slug AS bucket_slug FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number; name: string; notes: string | null; bucket_slug: string } | undefined;
    if (!row) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const current = accountMarkClpAtYmd(row.id, today, row.bucket_slug, {
      notes: row.notes,
      name: row.name,
    });
    const prior = accountMarkClpAtYmd(row.id, priorEnd, row.bucket_slug, {
      notes: row.notes,
      name: row.name,
    });
    if (!current || !prior || current.value_clp === prior.value_clp) return;

    const reconciled = reconcileDashboardCardMetrics(
      {
        deposits_clp: 0,
        current_value_clp: current.value_clp,
        prior_month_close_clp: prior.value_clp,
        deposits_month_clp: 0,
      },
      { includeUsd: false, reconcilePeriodDeltas: true }
    );
    expect(reconciled.delta_month_clp).not.toBe(0);
    expect(reconciled.delta_month_clp).toBeCloseTo(current.value_clp - prior.value_clp, 0);
  });
});

describe("depto mortgage live perf row", () => {
  it("current-month row is dated today with UF fields after live patch", () => {
    ensureDeptoSheetInDb();
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__mortgage' OR g.slug = 'mortgage'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!cur) return;

    expect(cur.as_of_date).toBe(today);
    expect(cur.uf_clp_day).not.toBeNull();
    expect(Number.isFinite(cur.uf_clp_day)).toBe(true);
    expect(cur.closing_balance_uf).not.toBeNull();
    expect(Number.isFinite(cur.closing_balance_uf)).toBe(true);
  });
});

describe("depto valuation timeseries live last point", () => {
  it("property chart last point is dated Chile today", () => {
    ensureDeptoSheetInDb();
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__property' AND a.name LIKE '%suecia%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    if (!ts?.accounts.points.length) return;

    const today = chileCalendarTodayYmd();
    const last = ts.accounts.points.reduce((a, b) =>
      String(a.as_of_date).localeCompare(String(b.as_of_date)) >= 0 ? a : b
    );
    expect(String(last.as_of_date)).toBe(today);
  });
});

describe("accountMarkClpAtYmd equity zero position", () => {
  it("returns 0 CLP at a date before first share purchase", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.equity_ticker FROM accounts a
         WHERE a.equity_ticker IS NOT NULL AND a.equity_ticker != ''
         ORDER BY a.id LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string } | undefined;
    if (!row || !accountUsesEquityMtm(row.id)) return;

    const firstBuy = db
      .prepare(
        `SELECT MIN(occurred_on) AS d FROM movements
         WHERE account_id = ? AND COALESCE(units_delta, 0) > 0`
      )
      .get(row.id) as { d: string | null } | undefined;
    if (!firstBuy?.d) return;

    const priorYmd = priorPeriodEndYmd("ytd", firstBuy.d);
    if (priorYmd >= firstBuy.d) return;
    expect(equityShareUnitsThroughYmd(row.id, priorYmd)).toBe(0);

    const mark = accountMarkClpAtYmd(row.id, priorYmd, "acciones");
    expect(mark?.value_clp).toBe(0);
    expect(mark?.as_of_date).toBe(priorYmd);
  });
});
