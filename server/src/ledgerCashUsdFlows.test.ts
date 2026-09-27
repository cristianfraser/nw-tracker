import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { db } from "./db.js";
import { flowEventInUnit, flowsDepositsNetTotalUsdByAccount } from "./flowsDeposits.js";
import { loadAccountRowsForGroupConsolidation } from "./groupMonthlyPerfConsolidation.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

/**
 * CLP ledger cash and checking accounts take their USD deposits event by event, like USD cash
 * and every other account: each deposit at its own date's rate. Three fixture months inside the
 * test preset's market window; the middle one has no events while the rate moves.
 */
const FIXTURE_NOTE = "vitest-ledger-cash-usd-flows";
const CLP_CASH_NAME = "vitest-ledger-cash-usd-flows-clp";
const CHECKING_NAME = "vitest-ledger-cash-usd-flows-vista";

const thisMonth = monthKeyFromYmd(chileCalendarTodayYmd());
const M1 = addCalendarMonths(thisMonth, -5);
const M2 = addCalendarMonths(thisMonth, -4); // no events: only the rate moves
const M3 = addCalendarMonths(thisMonth, -3);
const FIXTURE_MONTHS = [M1, M2, M3];

describe("CLP ledger cash and checking: USD deposits event by event", () => {
  let clpId = 0;
  let clpSlug = "";
  let checkingId = 0;
  let checkingSlug = "";
  let restoreFx: (() => void) | null = null;

  beforeAll(() => {
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug = 'brokerage_cash__clp'`)
      .get() as { id: number; slug: string } | undefined;
    const vistaLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug = 'cash_eqs__cuenta_vista'`)
      .get() as { id: number; slug: string } | undefined;
    if (!clpLeaf || !vistaLeaf) return;
    clpSlug = clpLeaf.slug;
    checkingSlug = vistaLeaf.slug;

    const insAccount = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    clpId = Number(insAccount.run(clpLeaf.id, CLP_CASH_NAME).lastInsertRowid);
    checkingId = Number(insAccount.run(vistaLeaf.id, CHECKING_NAME).lastInsertRowid);

    restoreFx = overrideFxDaily([
      [`${M1}-10`, 900],
      [`${M1}-12`, 905],
      [`${M1}-20`, 910],
      [monthEndUtcYmd(M1), 920],
      [monthEndUtcYmd(M2), 950],
      [`${M3}-05`, 960],
      [`${M3}-25`, 945],
      [monthEndUtcYmd(M3), 940],
    ]);

    const single = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    single.run(clpId, 1_000_000, `${M1}-10`, FIXTURE_NOTE, null);
    // A commission is the account's own P/L, never a deposit.
    single.run(clpId, -2_000, `${M1}-20`, FIXTURE_NOTE, "cash_fee");
    single.run(checkingId, 300_000, `${M1}-12`, FIXTURE_NOTE, null);
    single.run(checkingId, -250_000, `${M3}-25`, FIXTURE_NOTE, null);
    db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (NULL, ?, ?, 400000, 'clp', ?, ?)`
    ).run(clpId, checkingId, `${M3}-05`, FIXTURE_NOTE);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(CLP_CASH_NAME, CHECKING_NAME);
  });

  /** Σ of the account's deposit events in the calendar month, in `unit`. */
  const eventsInMonth = (accountId: number, mk: string, unit: "clp" | "usd"): number =>
    getMergedDisplayDepositInflowEventsForAccount(accountId)
      .filter((e) => monthKeyFromYmd(e.occurred_on) === mk)
      .reduce((s, e) => s + flowEventInUnit(e, unit), 0);

  /** Σ of the account's deposit events through `ymd`, in `unit`. */
  const eventsThrough = (accountId: number, ymd: string, unit: "clp" | "usd"): number =>
    getMergedDisplayDepositInflowEventsForAccount(accountId)
      .filter((e) => e.occurred_on <= ymd)
      .reduce((s, e) => s + flowEventInUnit(e, unit), 0);

  const rowForMonth = <T extends { as_of_date: string }>(rows: readonly T[], mk: string): T => {
    const row = rows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
    if (!row) throw new Error(`no row for ${mk}`);
    return row;
  };

  it("group consolidation: each month's USD flow is its events at their own dates' rates", () => {
    if (!clpId) return;
    for (const [id, slug] of [
      [clpId, clpSlug],
      [checkingId, checkingSlug],
    ] as const) {
      const usd = loadAccountRowsForGroupConsolidation(id, slug, "usd");
      const clp = loadAccountRowsForGroupConsolidation(id, slug, "clp");
      for (const mk of FIXTURE_MONTHS) {
        expect(rowForMonth(usd, mk).net_capital_flow).toBeCloseTo(eventsInMonth(id, mk, "usd"), 8);
        expect(rowForMonth(clp, mk).net_capital_flow).toBe(eventsInMonth(id, mk, "clp"));
      }
      // No events, a moving rate: the flow is exactly 0 and the pesos' fx move is the P/L.
      const m1 = rowForMonth(usd, M1);
      const m2 = rowForMonth(usd, M2);
      expect(m2.net_capital_flow).toBe(0);
      expect(m2.nominal_pl).toBeCloseTo(m2.closing_value - m1.closing_value, 8);
      expect(m2.closing_value).not.toBeCloseTo(m1.closing_value, 2);
    }
    // In pesos the events sum to balance − interest: the fee stays out of the flow, and the
    // transfer month reads no P/L.
    const clpRows = loadAccountRowsForGroupConsolidation(clpId, clpSlug, "clp");
    expect(rowForMonth(clpRows, M1).net_capital_flow).toBe(1_000_000);
    expect(rowForMonth(clpRows, M3).nominal_pl).toBe(0);
    expect(rowForMonth(clpRows, M3).closing_value).toBe(clpCashBalanceClpAt(clpId, monthEndUtcYmd(M3)));
    const checkingRows = loadAccountRowsForGroupConsolidation(checkingId, checkingSlug, "clp");
    expect(rowForMonth(checkingRows, M3).closing_value).toBe(
      checkingMovementBalanceClpAtCached(checkingId, monthEndUtcYmd(M3))
    );
  });

  it("the account's performance table and aportes line read the same events", () => {
    if (!clpId) return;
    const perf = getAccountMonthlyPerformance(clpId, "usd")?.monthly ?? [];
    const cons = loadAccountRowsForGroupConsolidation(clpId, clpSlug, "usd");
    for (const mk of [M2, M3]) {
      expect(rowForMonth(perf, mk).net_capital_flow).toBeCloseTo(rowForMonth(cons, mk).net_capital_flow, 8);
    }
    const ts = getAccountValuationTimeseries(clpId, "usd", {});
    const depKey = `${clpId}__dep`;
    for (const mk of FIXTURE_MONTHS) {
      const me = monthEndUtcYmd(mk);
      const pt = ts?.accounts.points.find((p) => p.as_of_date === me);
      expect(pt?.[depKey]).toBeCloseTo(eventsThrough(clpId, me, "usd"), 8);
    }
    // Pesos: the aportes line is balance − interest (the commission stays P/L).
    const tsClp = getAccountValuationTimeseries(clpId, "clp", {});
    const ptClp = tsClp?.accounts.points.find((p) => p.as_of_date === monthEndUtcYmd(M1));
    expect(ptClp?.[depKey]).toBe(1_000_000);
  });

  it("lifetime USD flows equal the dashboard card's deposits", () => {
    if (!clpId) return;
    const cardUsd = flowsDepositsNetTotalUsdByAccount();
    for (const [id, slug] of [
      [clpId, clpSlug],
      [checkingId, checkingSlug],
    ] as const) {
      const rows = loadAccountRowsForGroupConsolidation(id, slug, "usd");
      const flows = rows.reduce((s, r) => s + r.net_capital_flow, 0);
      expect(flows).toBeCloseTo(cardUsd.get(id)!, 8);
    }
  });

  it("the first month carries its P/L, so lifetime P/L is the close less every flow", () => {
    if (!clpId) return;
    for (const [id, slug] of [
      [clpId, clpSlug],
      [checkingId, checkingSlug],
    ] as const) {
      for (const unit of ["clp", "usd"] as const) {
        const rows = loadAccountRowsForGroupConsolidation(id, slug, unit); // newest first
        const first = rowForMonth(rows, M1);
        expect(first.nominal_pl).toBeCloseTo(first.closing_value - first.net_capital_flow, 8);
        const flows = rows.reduce((s, r) => s + r.net_capital_flow, 0);
        expect(rows[0]!.cumulative_nominal_pl).toBeCloseTo(rows[0]!.closing_value - flows, 8);
      }
    }
    // Pesos: the first month's P/L is the commission charged in it.
    const clpRows = loadAccountRowsForGroupConsolidation(clpId, clpSlug, "clp");
    expect(rowForMonth(clpRows, M1).nominal_pl).toBe(-2_000);
  });
});
