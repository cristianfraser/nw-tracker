import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import {
  loadEquityBrokerageCapitalInflowEvents,
  loadUsdCashCapitalSortFlows,
} from "./equityBrokerageCapitalFlows.js";
import {
  getMergedDisplayDepositInflowEventsForAccount,
  totalDisplayDepositsClpForAccount,
} from "./accountDeposits.js";
import { netDepositFlowBetween } from "./flowsDeposits.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { cashInterestUsdThroughDate } from "./cashAccountInterest.js";

const FIXTURE_USD = "vitest-usdcash-events-usd";
const FIXTURE_CLP = "vitest-usdcash-events-clp";
const FIXTURE_STOCK = "vitest-usdcash-events-stock";
const FIXTURE_NOTE = "vitest-usdcash-events";

const COMPRA_DATE = "2026-05-05";
const BUY_DATE = "2026-05-12";
const DIV_DATE = "2026-05-28";

describe("USD-cash deposit events (event-based, native-frame)", () => {
  let usdId = 0;
  let clpId = 0;
  let stockId = 0;
  let restoreFx: (() => void) | null = null;

  const insertTransfer = (v: {
    from: number;
    to: number;
    amount: number;
    currency: string;
    counter_amount?: number | null;
    counter_currency?: string | null;
    occurred_on: string;
    units_delta?: number | null;
    flow_kind: string;
    ticker?: string | null;
  }): void => {
    db.prepare(
      `INSERT INTO movements (
         account_id, from_account_id, to_account_id, amount, currency,
         counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind, ticker
       ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      v.from,
      v.to,
      v.amount,
      v.currency,
      v.counter_amount ?? null,
      v.counter_currency ?? null,
      v.occurred_on,
      FIXTURE_NOTE,
      v.units_delta ?? null,
      v.flow_kind,
      v.ticker ?? null
    );
  };

  beforeAll(() => {
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number } | undefined;
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number } | undefined;
    const stockLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!usdLeaf || !clpLeaf || !stockLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?)`).run(
      FIXTURE_USD,
      FIXTURE_CLP,
      FIXTURE_STOCK
    );
    const ins = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`
    );
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD, null).lastInsertRowid);
    clpId = Number(ins.run(clpLeaf.id, FIXTURE_CLP, null).lastInsertRowid);
    stockId = Number(ins.run(stockLeaf.id, FIXTURE_STOCK, "VITESTUC").lastInsertRowid);

    restoreFx = overrideFxDaily([
      [COMPRA_DATE, 900],
      [BUY_DATE, 920],
      [DIV_DATE, 950],
    ]);

    // CLP → USD conversion: real legs on both sides (900.000 CLP ↔ 1.000 USD).
    insertTransfer({
      from: clpId,
      to: usdId,
      amount: 900_000,
      currency: "clp",
      counter_amount: 1_000,
      counter_currency: "usd",
      occurred_on: COMPRA_DATE,
      flow_kind: "compra_usd_venta_clp",
    });
    // USD stock buy funded from the cash account (different day — no wire match).
    insertTransfer({
      from: usdId,
      to: stockId,
      amount: 400,
      currency: "usd",
      occurred_on: BUY_DATE,
      units_delta: 4,
      flow_kind: "stock_buy",
      ticker: "VITESTUC",
    });
    // Cash dividend back into USD cash.
    insertTransfer({
      from: stockId,
      to: usdId,
      amount: 20,
      currency: "usd",
      occurred_on: DIV_DATE,
      flow_kind: "dividend_payout",
    });
    // Interest: raises the balance but is P/L, never a deposit event.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'usd', ?, ?, 'savings_earnings')`
    ).run(usdId, 0.5, DIV_DATE, FIXTURE_NOTE);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?)`).run(
      FIXTURE_USD,
      FIXTURE_CLP,
      FIXTURE_STOCK
    );
  });

  it("emits per-event native legs: real compra pesos, mirrored equity legs, no interest", () => {
    if (!usdId) return;
    const events = getMergedDisplayDepositInflowEventsForAccount(usdId);
    expect(events).toHaveLength(3); // compra + stock_buy + dividend; interest excluded

    const compra = events.find((e) => e.occurred_on === COMPRA_DATE)!;
    expect(compra.amt).toBe(900_000); // the actual pesos that moved, not 1.000 × fx
    expect(compra.amt_usd).toBe(1_000);

    // The stock_buy / dividend legs mirror the stock side's attribution exactly (bucket-level
    // netting to the peso): cash event = −(stock event).
    const stockEvents = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId)!;
    const stockBuy = stockEvents.find((e) => e.occurred_on === BUY_DATE)!;
    const cashBuy = events.find((e) => e.occurred_on === BUY_DATE)!;
    expect(cashBuy.amt).toBe(-stockBuy.amt);
    expect(cashBuy.amt_usd).toBe(-stockBuy.amt_usd!);

    const stockDiv = stockEvents.find((e) => e.occurred_on === DIV_DATE)!;
    const cashDiv = events.find((e) => e.occurred_on === DIV_DATE)!;
    expect(cashDiv.amt).toBe(-stockDiv.amt);
    expect(cashDiv.amt_usd).toBe(-stockDiv.amt_usd!);
  });

  it("keeps the USD-frame identity: Σ event USD = balance − cumulative interest", () => {
    if (!usdId) return;
    const events = getMergedDisplayDepositInflowEventsForAccount(usdId);
    const sumUsd = events.reduce((s, e) => s + (e.amt_usd ?? 0), 0);
    const balance = usdCashBalanceUsdAt(usdId, "2026-06-30");
    const interest = cashInterestUsdThroughDate(usdId, "2026-06-30");
    expect(sumUsd).toBeCloseTo(balance - interest, 6); // 620 = 620,5 − 0,5
  });

  it("a window with no events reads 0 deposits in both frames (no fx drift)", () => {
    if (!usdId) return;
    // fx moved 920 → 950 across this window, balance is standing — deposits must be exactly 0.
    expect(netDepositFlowBetween(usdId, "2026-06-01", "2026-06-30", "clp")).toBe(0);
    expect(netDepositFlowBetween(usdId, "2026-06-01", "2026-06-30", "usd")).toBe(0);
    // Windows containing events sum those events only.
    expect(netDepositFlowBetween(usdId, "2026-05-01", COMPRA_DATE, "usd")).toBe(1_000);
    expect(netDepositFlowBetween(usdId, "2026-05-01", COMPRA_DATE, "clp")).toBe(900_000);
  });

  it("lifetime deposited = Σ events (per-event CLP), and the loader skips non-usd-cash ids", () => {
    if (!usdId) return;
    const events = getMergedDisplayDepositInflowEventsForAccount(usdId);
    const expected = events.reduce((s, e) => s + e.amt, 0);
    expect(totalDisplayDepositsClpForAccount(usdId)).toBe(expected);
    expect(loadUsdCashCapitalSortFlows([stockId, clpId]).size).toBe(0);
  });

  it("compra legs cancel at bucket level: the CLP side emits the same pesos negated", () => {
    if (!clpId) return;
    const clpEvents = getMergedDisplayDepositInflowEventsForAccount(clpId);
    const clpLeg = clpEvents.find((e) => e.occurred_on === COMPRA_DATE)!;
    expect(clpLeg.amt).toBe(-900_000);
  });

});
