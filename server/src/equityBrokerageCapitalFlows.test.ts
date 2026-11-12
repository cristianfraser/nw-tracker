import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { db } from "./db.js";
import { getMergedDepositInflowEventsForAccount, pocketDepositsClpForAccount } from "./accountDeposits.js";
import {
  loadEquityBrokerageCapitalInflowEvents,
  loadEquityBrokerageCapitalSortFlows,
  loadUsdCashCapitalSortFlows,
  type EquityCapitalSortFlow,
} from "./equityBrokerageCapitalFlows.js";
import { equityReturnSnapshot, totalDividendsClpForAccount } from "./equityReturns.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

const FIXTURE_USD = "vitest-equity-cap-usd";
const FIXTURE_CLP = "vitest-equity-cap-clp";
const FIXTURE_STOCK = "vitest-equity-cap-stock";
const FIXTURE_NOTE = "vitest-equity-capital-flows";

function findEquityAccountByName(name: string): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE name = ? LIMIT 1`).get(name) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

function hasStockBuyTransfer(accountId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM movements
         WHERE to_account_id = ? AND flow_kind = 'stock_buy' LIMIT 1`
      )
      .get(accountId) != null
  );
}

let restoreFx: (() => void) | null = null;

describe("equityBrokerageCapitalFlows fixture", () => {
  let usdId = 0;
  let clpId = 0;
  let stockId = 0;
  let transferId = 0;

  beforeAll(() => {
    const leaf = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    const usdLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf || !usdLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?)`).run(FIXTURE_USD, FIXTURE_CLP, FIXTURE_STOCK);

    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`);
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD, null).lastInsertRowid);
    clpId = Number(ins.run(usdLeaf.id, FIXTURE_CLP, null).lastInsertRowid);
    stockId = Number(ins.run(leaf.id, FIXTURE_STOCK, "VITEST").lastInsertRowid);

    transferId = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount, currency, occurred_on, note,
             units_delta, flow_kind
           ) VALUES (NULL, ?, ?, 100, 'usd', '2026-05-28', ?, 1.5, 'stock_buy')`
        )
        .run(usdId, stockId, FIXTURE_NOTE).lastInsertRowid
    );

    restoreFx = overrideFxDaily([
      ["2026-04-30", 900],
      ["2026-05-05", 900],
      ["2026-03-26", 900],
    ]);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?)`).run(FIXTURE_USD, FIXTURE_CLP, FIXTURE_STOCK);
  });

  it("loads stock_buy transfer as CLP capital inflow", () => {
    if (!usdId || !stockId || !transferId) return;
    expect(accountUsesEquityMtm(stockId)).toBe(true);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    expect(full).toHaveLength(1);
    expect(full[0]!.occurred_on).toBe("2026-05-28");
    expect(full[0]!.amt).toBeCloseTo(usdToClpReferenceRounded(100, "2026-05-28")!, 0);

    const merged = getMergedDepositInflowEventsForAccount(stockId);
    expect(merged.reduce((s, e) => s + e.amt, 0)).toBeCloseTo(full[0]!.amt, 0);
  });

  it("loads stock_buy on account_id (panel create without transfer row) as capital inflow", () => {
    if (!stockId) return;
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(`${FIXTURE_NOTE}|account-id-buy`);

    const buyId = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, amount, currency, occurred_on, note, units_delta, flow_kind
           ) VALUES (?, 50, 'usd', '2026-06-16', ?, 2, 'stock_buy')`
        )
        .run(stockId, `${FIXTURE_NOTE}|account-id-buy`).lastInsertRowid
    );
    expect(buyId).toBeGreaterThan(0);

    const full = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    const june = full.filter((e) => e.occurred_on === "2026-06-16");
    expect(june).toHaveLength(1);
    expect(june[0]!.amt).toBeCloseTo(usdToClpReferenceRounded(50, "2026-06-16")!, 0);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(buyId);
  });

  it("dividend_payout transfer is a negative capital flow and informational dividend income", () => {
    if (!usdId || !stockId) return;

    const divId = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount, currency, occurred_on, note,
             units_delta, flow_kind
           ) VALUES (NULL, ?, ?, 1.7, 'usd', '2026-03-26', ?, NULL, 'dividend_payout')`
        )
        .run(stockId, usdId, `${FIXTURE_NOTE}|payout-div`).lastInsertRowid
    );

    const events = marchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.amt).toBe(-usdToClpReferenceRounded(1.7, "2026-03-26")!);
    expect(totalDividendsClpForAccount(stockId)).toBeCloseTo(
      usdToClpReferenceRounded(1.7, "2026-03-26")!,
      0
    );

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(divId);
  });

  it("throws on any row using the retired dividend_usd kind", () => {
    if (!stockId) return;
    const divId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
           VALUES (?, 1.7, 'usd', '2026-02-05', ?, 'dividend_usd', 0.01)`
        )
        .run(stockId, `${FIXTURE_NOTE}|retired-drip`).lastInsertRowid
    );

    expect(() => loadEquityBrokerageCapitalInflowEvents([stockId])).toThrow(/retired dividend_usd/);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(divId);
  });

  function insertWire(clp: number, usd: number, note: string): number {
    // Legacy shape was a single-leg compra row on the USD account carrying both legs; the
    // new schema CHECK forbids the counter pair on single-leg rows (and migration 169
    // asserted no such row exists), so the wire is written as a cross-currency transfer
    // arriving at the USD account — the same evidence `sameDayWireLegs` reads either way.
    return Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
           VALUES (NULL, ?, ?, ?, 'clp', ?, 'usd', '2026-03-26', ?, 'compra_usd_venta_clp')`
        )
        .run(clpId, usdId, clp, usd, note).lastInsertRowid
    );
  }

  function insertBuy(usd: number, units: number, note: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount, currency, occurred_on, note,
             units_delta, flow_kind
           ) VALUES (NULL, ?, ?, ?, 'usd', '2026-03-26', ?, ?, 'stock_buy')`
        )
        .run(usdId, stockId, usd, note, units).lastInsertRowid
    );
  }

  function marchEvents() {
    const all = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
    return all.filter((e) => e.occurred_on === "2026-03-26");
  }

  it("stock_buy with exact same-day wire counts the wire CLP at face (clp_wire)", () => {
    if (!usdId || !stockId) return;
    const ids = [
      insertWire(50_000, 54.68, `${FIXTURE_NOTE}|wire-exact`),
      insertBuy(54.68, 0.865069, `${FIXTURE_NOTE}|wire-exact`),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.capital_kind).toBe("clp_wire");
    expect(events[0]!.amt).toBe(50_000);
    expect(events[0]!.amt_usd).toBeCloseTo(54.68, 6);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("wire smaller than the buy splits capital: wire CLP at face + residual at reference", () => {
    if (!usdId || !stockId) return;
    const ids = [
      insertWire(50_000, 54.68, `${FIXTURE_NOTE}|wire-partial`),
      insertBuy(55.22, 0.873613, `${FIXTURE_NOTE}|wire-partial`),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(2);
    const wire = events.find((e) => e.capital_kind === "clp_wire");
    const resid = events.find((e) => e.capital_kind === "usd_reference");
    expect(wire).toBeDefined();
    expect(wire!.amt).toBe(50_000);
    expect(wire!.amt_usd).toBeCloseTo(54.68, 6);
    expect(resid).toBeDefined();
    expect(resid!.amt).toBe(usdToClpReferenceRounded(55.22 - 54.68, "2026-03-26")!);
    expect(resid!.amt_usd).toBeCloseTo(0.54, 6);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function insertWireTransfer(clp: number, usd: number, note: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note,
             units_delta, flow_kind
           ) VALUES (NULL, ?, ?, ?, 'clp', ?, 'usd', '2026-03-26', ?, NULL, 'compra_usd_venta_clp')`
        )
        .run(clpId, usdId, clp, usd, note).lastInsertRowid
    );
  }

  it("compra TRANSFER leg into the cash account counts as an exact wire (clp_wire)", () => {
    if (!usdId || !clpId || !stockId) return;
    const ids = [
      insertWireTransfer(50_000, 54.68, `${FIXTURE_NOTE}|twire-exact`),
      insertBuy(54.68, 0.865069, `${FIXTURE_NOTE}|twire-exact`),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.capital_kind).toBe("clp_wire");
    expect(events[0]!.amt).toBe(50_000);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("compra TRANSFER wire smaller than the buy drives the composite split", () => {
    if (!usdId || !clpId || !stockId) return;
    const ids = [
      insertWireTransfer(50_000, 54.68, `${FIXTURE_NOTE}|twire-partial`),
      insertBuy(55.22, 0.873613, `${FIXTURE_NOTE}|twire-partial`),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(2);
    const wire = events.find((e) => e.capital_kind === "clp_wire");
    const resid = events.find((e) => e.capital_kind === "usd_reference");
    expect(wire?.amt).toBe(50_000);
    expect(resid?.amt).toBe(usdToClpReferenceRounded(55.22 - 54.68, "2026-03-26")!);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("single-leg + transfer wires on one day = ambiguous → full reference for a partial buy", () => {
    if (!usdId || !clpId || !stockId) return;
    const ids = [
      insertWire(50_000, 54.68, `${FIXTURE_NOTE}|mixed-wires`),
      insertWireTransfer(20_000, 21.87, `${FIXTURE_NOTE}|mixed-wires`),
      insertBuy(55.22, 0.873613, `${FIXTURE_NOTE}|mixed-wires`),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.capital_kind).toBe("usd_reference");
    expect(events[0]!.amt).toBe(usdToClpReferenceRounded(55.22, "2026-03-26")!);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE_NOTE}|wire-shared%`);
  });

  function marchSortFlows(): EquityCapitalSortFlow[] {
    const all = loadEquityBrokerageCapitalSortFlows([stockId]).get(stockId) ?? [];
    return all.filter((f) => f.occurred_on === "2026-03-26");
  }

  function marchCashFlows(): EquityCapitalSortFlow[] {
    const all = loadUsdCashCapitalSortFlows([usdId]).get(usdId) ?? [];
    return all.filter((f) => f.occurred_on === "2026-03-26");
  }

  it("one wire funding two same-day buys plus USD already held: wire pesos pro rata, uncovered dollars at reference", () => {
    if (!usdId || !stockId) return;
    const note = `${FIXTURE_NOTE}|wire-shared`;
    const priorDividend = Number(
      db
        .prepare(
          `INSERT INTO movements (
             account_id, from_account_id, to_account_id, amount, currency, occurred_on, note,
             units_delta, flow_kind
           ) VALUES (NULL, ?, ?, 2.13, 'usd', '2026-03-10', ?, NULL, 'dividend_payout')`
        )
        .run(stockId, usdId, note).lastInsertRowid
    );
    // Buys add up to the wire's dollars plus the prior dividend (40 + 16.81 = 54.68 + 2.13).
    const wireId = insertWire(50_000, 54.68, note);
    const buyA = insertBuy(40, 0.6, note);
    const buyB = insertBuy(16.81, 0.3, note);
    const total = 56.81;

    const flows = marchSortFlows();
    const byTie = new Map(flows.map((f) => [f.tie, f]));
    const aWire = byTie.get(`t:${buyA}:wire`)!;
    const bWire = byTie.get(`t:${buyB}:wire`)!;
    const aResid = byTie.get(`t:${buyA}:resid`)!;
    const bResid = byTie.get(`t:${buyB}:resid`)!;
    expect(flows).toHaveLength(4);
    expect(aWire.capital_kind).toBe("clp_wire");
    expect(aWire.amt).toBe(Math.round((50_000 * 40) / total));
    // The last buy takes the rest of the wire, so the pesos add up to it exactly.
    expect(aWire.amt + bWire.amt).toBe(50_000);
    expect(aWire.amt_usd! + bWire.amt_usd!).toBeCloseTo(54.68, 9);
    const aResidUsd = 40 - (54.68 * 40) / total;
    expect(aResid.capital_kind).toBe("usd_reference");
    expect(aResid.amt_usd).toBeCloseTo(aResidUsd, 9);
    expect(aResid.amt).toBe(usdToClpReferenceRounded(aResidUsd, "2026-03-26")!);
    expect(aResid.amt_usd! + bResid.amt_usd!).toBeCloseTo(2.13, 9);

    // The cash account mirrors the buys: the wire's pesos come in and go out again, and the
    // day nets to minus the dollars the prior balance paid for, at the reference rate.
    const cash = marchCashFlows();
    const cashNet = cash.reduce((s, f) => s + f.amt, 0);
    expect(cashNet).toBeCloseTo(-(aResid.amt + bResid.amt), 6);
    const stockSum = flows.reduce((s, f) => s + f.amt, 0);
    const cashBuyLegs = cash.filter((f) => f.tie.startsWith("t:"));
    expect(cashBuyLegs.reduce((s, f) => s + f.amt, 0)).toBeCloseTo(-stockSum, 6);

    for (const id of [priorDividend, wireId, buyA, buyB]) {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });

  it("one wire exactly covering two same-day buys carries no residual", () => {
    if (!usdId || !stockId) return;
    const note = `${FIXTURE_NOTE}|wire-shared-exact`;
    const wireId = insertWire(50_000, 54.68, note);
    const buyA = insertBuy(30, 0.5, note);
    const buyB = insertBuy(24.68, 0.4, note);

    const flows = marchSortFlows();
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => f.capital_kind === "clp_wire")).toBe(true);
    expect(flows.reduce((s, f) => s + f.amt, 0)).toBe(50_000);
    expect(marchCashFlows().reduce((s, f) => s + f.amt, 0)).toBeCloseTo(0, 6);

    for (const id of [wireId, buyA, buyB]) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("two same-day buys needing less than the wire keep the reference rate", () => {
    if (!usdId || !stockId) return;
    const note = `${FIXTURE_NOTE}|wire-shared-under`;
    const ids = [
      insertWire(50_000, 54.68, note),
      insertBuy(20, 0.3, note),
      insertBuy(10, 0.2, note),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.capital_kind === "usd_reference")).toBe(true);
    const amts = events.map((e) => e.amt).sort((a, b) => a - b);
    expect(amts).toEqual([
      usdToClpReferenceRounded(10, "2026-03-26")!,
      usdToClpReferenceRounded(20, "2026-03-26")!,
    ]);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("a same-day buy equal to the wire owns it; the other buy keeps the reference rate", () => {
    if (!usdId || !stockId) return;
    const note = `${FIXTURE_NOTE}|wire-shared-owner`;
    const ids = [
      insertWire(50_000, 54.68, note),
      insertBuy(54.68, 0.8, note),
      insertBuy(10, 0.2, note),
    ];

    const events = marchEvents();
    expect(events).toHaveLength(2);
    const wire = events.find((e) => e.capital_kind === "clp_wire");
    const ref = events.find((e) => e.capital_kind === "usd_reference");
    expect(wire?.amt).toBe(50_000);
    expect(ref?.amt).toBe(usdToClpReferenceRounded(10, "2026-03-26")!);

    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });
});

describe("equityBrokerageCapitalFlows on the Vitest person", () => {
  it("SPY return snapshot: total return vs deposited, dividends informational", () => {
    const spyId = findEquityAccountByName("SPY");
    if (spyId == null || !hasStockBuyTransfer(spyId)) return;

    const pocket = pocketDepositsClpForAccount(spyId);
    const dividends = totalDividendsClpForAccount(spyId);
    if (dividends <= 0) return;

    const snap = equityReturnSnapshot(spyId, pocket, pocket + 1_000, "clp");
    expect(snap).not.toBeNull();
    expect(snap!.dividends).toBeCloseTo(dividends, -2);
    expect(snap!.total_return).toBeCloseTo(1_000, 0);
  });
});

