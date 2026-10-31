import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFlowsDepositsPayload,
  flowEventInUnit,
  flowsDepositsNetTotalByAccount,
  isPreTaxDepositRow,
  markPensionSwitchRows,
  netDepositFlowBetween,
  type FlowDepositRow,
} from "./flowsDeposits.js";
import { totalDisplayDepositsClpForAccount } from "./accountDeposits.js";
import { clpToUsdAtPayment, ufRowOnOrBefore } from "./fxRates.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { ensureChildAssetGroupId } from "./assetGroupTree.js";

/**
 * Fixture dates inside the synthetic market window (the test preset covers the last ~18
 * months): the payload converts every row to USD at its own date, and a date with no rate
 * is an error.
 */
const fixtureYmd = (daysBack: number): string => chileCalendarAddDays(chileCalendarTodayYmd(), -daysBack);

/** CLP cash leaves of the fixtures: prefixed, under Efectivo › Cash savings, kind = last slug segment. */
const LEAF_STATE_BONUS = "cash_eqs__cash_savings__vitest_flows_deposits_state_bonus__clp";
const LEAF_FUTURE_DATED = "cash_eqs__cash_savings__vitest_flows_deposits_future_dated__clp";

/** Through `ensureChildAssetGroupId`, which also drops the memoized dashboard-bucket map. */
function insertCashLeaf(slug: string): number {
  const prefix = "cash_eqs__cash_savings__";
  return ensureChildAssetGroupId("cash_eqs__cash_savings", slug.slice(prefix.length), "Vitest cash leaf").id;
}

describe("buildFlowsDepositsPayload", () => {
  it("net_total_clp matches sum of row amounts", () => {
    const payload = buildFlowsDepositsPayload();
    const rowSum = payload.rows.reduce((s, r) => s + r.amount_clp, 0);
    expect(payload.net_total_clp).toBe(rowSum);
    expect(payload.net_total_usd).toBe(payload.rows.reduce((s, r) => s + r.amount_usd, 0));
    expect(Array.isArray(payload.fx_conversion_warnings)).toBe(true);
  });

  it("by_category totals match filtered rows", () => {
    const payload = buildFlowsDepositsPayload();
    for (const cat of Object.keys(payload.by_category) as (keyof typeof payload.by_category)[]) {
      const block = payload.by_category[cat];
      const sum = block.rows.reduce((s, r) => s + r.amount_clp, 0);
      expect(block.total_clp).toBe(sum);
    }
  });

  it("day points carry each day's deposits by category and add up to the month points", () => {
    const payload = buildFlowsDepositsPayload();
    for (const [daily, monthly, amountOf] of [
      [payload.chart_daily, payload.chart_monthly, (r: { amount_clp: number }) => r.amount_clp],
      [payload.chart_daily_usd, payload.chart_monthly_usd, (r: { amount_usd: number }) => r.amount_usd],
    ] as const) {
      const days = daily.map((p) => p.as_of_date);
      expect(days).toEqual([...new Set(payload.rows.map((r) => r.occurred_on.slice(0, 10)))].sort());
      for (const p of daily) {
        const rows = payload.rows.filter((r) => r.occurred_on.slice(0, 10) === p.as_of_date);
        expect(p.total).toBeCloseTo(rows.reduce((s, r) => s + amountOf(r as never), 0), 6);
        expect(p.total).toBeCloseTo(p.real_estate + p.cash + p.brokerage + p.inversiones, 6);
      }
      for (const m of monthly) {
        const inMonth = daily.filter((p) => p.as_of_date.slice(0, 7) === m.as_of_date.slice(0, 7));
        expect(inMonth.reduce((s, p) => s + p.total, 0)).toBeCloseTo(m.total, 6);
      }
    }
  });
});

describe("state contributions are P/L, not deposits", () => {
  let accountId: number | null = null;

  beforeAll(() => {
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`)
        .run(insertCashLeaf(LEAF_STATE_BONUS), "vitest-flows-deposits-state-bonus").lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    ins.run(accountId, 100_000, fixtureYmd(100), "vitest personal deposit", null);
    ins.run(accountId, 50_000, fixtureYmd(90), "vitest state bonus", "aporte_estatal_clp");
  });

  afterAll(() => {
    if (accountId == null) return;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM asset_groups WHERE slug = ?`).run(LEAF_STATE_BONUS);
  });

  it("excludes aporte_estatal_clp from deposit rows and per-account totals", () => {
    if (accountId == null) return;
    const payload = buildFlowsDepositsPayload();
    const rows = payload.rows.filter((r) => r.account_id === accountId);
    expect(rows.map((r) => r.amount_clp)).toEqual([100_000]);
    expect(flowsDepositsNetTotalByAccount().get(accountId)).toBe(100_000);
  });
});

describe("forward-posted movements count today and move to their bank date when it arrives", () => {
  let accountId: number | null = null;

  beforeAll(() => {
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`)
        .run(insertCashLeaf(LEAF_FUTURE_DATED), "vitest-flows-deposits-future-dated").lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    ins.run(accountId, 100_000, fixtureYmd(100), "vitest past deposit", null);
    // Bank-scheduled giro imported from a partial cartola before its value date.
    ins.run(accountId, -130_000, chileCalendarAddDays(chileCalendarTodayYmd(), 2), "vitest future giro", null);
  });

  afterAll(() => {
    if (accountId == null) return;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM asset_groups WHERE slug = ?`).run(LEAF_FUTURE_DATED);
  });

  it("includes the forward-posted giro in totals and lists it under today with its bank date", () => {
    if (accountId == null) return;
    const today = chileCalendarTodayYmd();
    const postedOn = chileCalendarAddDays(today, 2);
    // As-of-now like the balance (`displayLedgerCutoffYmd`): the giro is already money out.
    expect(flowsDepositsNetTotalByAccount().get(accountId)).toBe(-30_000);
    expect(totalDisplayDepositsClpForAccount(accountId)).toBe(-30_000);
    const rows = buildFlowsDepositsPayload()
      .rows.filter((r) => r.account_id === accountId)
      .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    expect(rows.map((r) => [r.occurred_on, r.amount_clp, r.posted_on ?? null])).toEqual([
      [fixtureYmd(100), 100_000, null],
      [today, -130_000, postedOn],
    ]);
    // Window legs: today's bucket carries it, a window that ends yesterday does not.
    expect(netDepositFlowBetween(accountId, chileCalendarAddDays(today, -1), today, "clp")).toBe(-130_000);
    expect(
      netDepositFlowBetween(accountId, chileCalendarAddDays(today, -3), chileCalendarAddDays(today, -1), "clp")
    ).toBe(0);
  });
});

describe("flowsDepositsNetTotalByAccount", () => {
  it("sums match payload rows per account", () => {
    const payload = buildFlowsDepositsPayload();
    const byAccount = flowsDepositsNetTotalByAccount();
    const fromRows = new Map<number, number>();
    for (const r of payload.rows) {
      fromRows.set(r.account_id, (fromRows.get(r.account_id) ?? 0) + r.amount_clp);
    }
    // Unrounded amounts summed in a different order: equal up to float noise.
    for (const [id, total] of fromRows) {
      expect(byAccount.get(id)).toBeCloseTo(total, 6);
    }
  });
});

describe("flowEventInUnit", () => {
  const onDate = (): string | null =>
    (db.prepare(`SELECT MAX(date) AS d FROM fx_daily WHERE date <= ?`).get(chileCalendarTodayYmd()) as {
      d: string | null;
    }).d;

  it("keeps the legs an event carries and converts only a missing one, at its own date", () => {
    const date = onDate();
    if (date == null) return;
    // CLP always native; recorded dollars kept as is (sign follows the CLP leg).
    expect(flowEventInUnit({ occurred_on: date, amt: -950_000, amt_usd: 1_000 }, "clp")).toBe(-950_000);
    expect(flowEventInUnit({ occurred_on: date, amt: -950_000, amt_usd: 1_000 }, "usd")).toBe(-1_000);
    // CLP-only: the buy rate on or before the event date, unrounded.
    expect(flowEventInUnit({ occurred_on: date, amt: 123_457 }, "usd")).toBe(clpToUsdAtPayment(123_457, date));
    const uf = ufRowOnOrBefore(date);
    if (uf) expect(flowEventInUnit({ occurred_on: date, amt: 123_457 }, "uf")).toBe(123_457 / uf.clp_per_uf);
    expect(flowEventInUnit({ occurred_on: date, amt: 0, amt_usd: 5 }, "usd")).toBe(0);
  });

  it("throws when the event's date has no rate, instead of dropping the flow", () => {
    expect(() => flowEventInUnit({ occurred_on: "1900-01-02", amt: 10_000 }, "usd")).toThrow(/no USD rate/);
    expect(() => flowEventInUnit({ occurred_on: "1900-01-02", amt: 10_000 }, "uf")).toThrow(/no UF/);
    // A recorded USD leg needs no rate.
    expect(flowEventInUnit({ occurred_on: "1900-01-02", amt: 10_000, amt_usd: 12 }, "usd")).toBe(12);
  });
});

describe("markPensionSwitchRows", () => {
  const row = (account_id: number, occurred_on: string, amount_clp: number, kind_slug = "afp"): FlowDepositRow => ({
    occurred_on,
    category: "inversiones",
    category_label: "Retirement",
    account_id,
    account_name: `acct ${account_id}`,
    kind_slug,
    amount_clp,
    amount_usd: amount_clp / 900,
  });

  it("marks a fund switch's two legs pre-tax, so they cancel there", () => {
    const rows = [row(1, "2020-02-07", -3_205_366), row(2, "2020-02-07", 3_205_366), row(2, "2020-02-10", 134_587)];
    markPensionSwitchRows(rows);
    expect(rows.map((r) => r.pension_switch ?? false)).toEqual([true, true, false]);
    const preTax = rows.filter(isPreTaxDepositRow).reduce((s, r) => s + r.amount_clp, 0);
    expect(preTax).toBe(134_587);
  });

  it("leaves a retiro (negative pension row with no same-day twin) an ordinary deposit row", () => {
    const rows = [row(1, "2020-08-03", -1_200_000), row(2, "2020-08-04", 1_200_000), row(3, "2020-08-03", 1_200_000, "spy")];
    markPensionSwitchRows(rows);
    expect(rows.some((r) => r.pension_switch)).toBe(false);
    expect(isPreTaxDepositRow(rows[0]!)).toBe(false);
  });
});
