/**
 * The 1040's reading of the tax facts (`facts.ts`) and the PFIC predicate (`pfic.ts`) on synthetic
 * fixtures in a year no fixture person reaches: which disposals reach Form 8949 and through which
 * box, which dividends are qualified and where their US withholding goes, and the throw on a dollar
 * dividend without its broker document.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { usDisposalLots, usDividendItems } from "./facts.js";
import { isPficEquityTicker, isPficInstrument } from "./pfic.js";

const PREFIX = "vitest-us1040-facts";
const YEAR = 2097;
const WINDOW = { fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-12-31` };
const accounts: number[] = [];
const movements: number[] = [];

function account(leafSlug: string, key: string, ticker: string | null = null): number {
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(leafSlug) as { id: number } | undefined;
  if (!leaf) throw new Error(`asset group ${leafSlug} missing`);
  const id = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key, equity_ticker) VALUES (?, ?, ?, ?)`).run(leaf.id, `${PREFIX} ${key}`, `${PREFIX}|${key}`, ticker)
      .lastInsertRowid
  );
  accounts.push(id);
  return id;
}

function movement(row: { from: number; to: number; amount: number; day: string; kind: string; units?: number }): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind, units_delta) VALUES (?, ?, ?, 'usd', ?, ?, ?, ?)`
      )
      .run(row.from, row.to, row.amount, row.day, `${PREFIX} movement`, row.kind, row.units ?? null).lastInsertRowid
  );
  movements.push(id);
  return id;
}

function detail(movementId: number, gross: number, withholding: number): void {
  db.prepare(
    `INSERT INTO movement_dividend_details (movement_id, gross_amount, withholding_amount, currency, withholding_rate_pct, withholding_jurisdiction, tax_residency_country, source)
     VALUES (?, ?, ?, 'usd', ?, ?, 'CHL', 'manual')`
  ).run(movementId, gross, withholding, gross > 0 ? (withholding / gross) * 100 : 0, withholding > 0 ? "US" : null);
}

describe("the 1040's facts", () => {
  let ibkr = 0;
  let clBroker = 0;
  let spy = 0;
  let vea = 0;
  let ucits = 0;
  let undocumented = 0;

  beforeAll(() => {
    ibkr = account("cash_eqs__cash_savings__usd", "ibkr");
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'broker_cash', 'ibkr|usd')`).run(ibkr);
    clBroker = account("cash_eqs__cash_savings__usd", "cl-broker");
    spy = account("brokerage_acciones", "spy", "SPY");
    vea = account("brokerage_acciones", "vea", "VEA");
    ucits = account("brokerage_acciones", "cspx", "CSPX.L");
    // SPY at the US broker: bought the year before, half sold in the window (long and short slices).
    movement({ from: ibkr, to: spy, amount: 1_000, day: `${YEAR - 1}-03-01`, kind: "stock_buy", units: 10 });
    movement({ from: ibkr, to: spy, amount: 1_200, day: `${YEAR - 1}-09-01`, kind: "stock_buy", units: 10 });
    movement({ from: spy, to: ibkr, amount: 2_600, day: `${YEAR}-06-02`, kind: "stock_sell", units: 20 });
    // VEA through the Chilean broker (no 1099-B), and a UCITS line (a PFIC: Form 8621's, not Schedule D's).
    movement({ from: clBroker, to: vea, amount: 500, day: `${YEAR}-01-10`, kind: "stock_buy", units: 10 });
    movement({ from: vea, to: clBroker, amount: 450, day: `${YEAR}-02-10`, kind: "stock_sell", units: 10 });
    movement({ from: ibkr, to: ucits, amount: 700, day: `${YEAR}-01-10`, kind: "stock_buy", units: 1 });
    movement({ from: ucits, to: ibkr, amount: 800, day: `${YEAR}-03-10`, kind: "stock_sell", units: 1 });
    // Dividends: SPY at the US broker paid whole; VEA at the Chilean broker with the 15 % withheld.
    detail(movement({ from: spy, to: ibkr, amount: 20, day: `${YEAR}-03-08`, kind: "dividend_payout" }), 20, 0);
    detail(movement({ from: vea, to: clBroker, amount: 8.5, day: `${YEAR}-01-30`, kind: "dividend_payout" }), 10, 1.5);
  });

  afterAll(() => {
    for (const id of movements.splice(0)) {
      db.prepare(`DELETE FROM movement_dividend_details WHERE movement_id = ?`).run(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    for (const id of accounts.splice(0)) {
      db.prepare(`DELETE FROM account_roles WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  it("reads the PFIC predicate from the registry", () => {
    expect(isPficEquityTicker("CSPX.L")).toBe(true);
    expect(isPficEquityTicker("CFIETFIPSA.SN")).toBe(true);
    expect(isPficEquityTicker("SPY")).toBe(false);
    expect(isPficInstrument({ ticker: "VEA" })).toBe(false);
    expect(isPficInstrument({ accountId: spy })).toBe(false);
  });

  it("takes every non-PFIC sale, the box by the broker that sold it", () => {
    const lots = usDisposalLots(WINDOW).filter((l) => l.source === "equity");
    expect(lots.map((l) => [l.instrument, l.sold, l.units, l.proceedsUsd, l.reportedOn1099B])).toEqual([
      ["VEA", `${YEAR}-02-10`, 10, 450, false],
      ["SPY", `${YEAR}-06-02`, 20, 2_600, true],
    ]);
    expect(lots[1]!.slices.map((s) => [s.acquiredOn, s.units, s.costUsd])).toEqual([
      [`${YEAR - 1}-03-01`, 10, 1_000],
      [`${YEAR - 1}-09-01`, 10, 1_200],
    ]);
  });

  it("qualifies a US-listed dividend, and files the Chilean broker's US withholding as a Form 1042-S", () => {
    const items = usDividendItems(WINDOW);
    const vd = items.find((d) => d.instrument === "VEA")!;
    const sd = items.find((d) => d.instrument === "SPY")!;
    expect(vd).toMatchObject({ usd: 10, qualified: true, usSource: true, usWithheldUsd: 1.5, usWithholdingForm: "1042-S", foreignTaxUsd: 0 });
    expect(sd).toMatchObject({ usd: 20, qualified: true, usWithheldUsd: 0, usWithholdingForm: null });
  });

  it("refuses a dollar dividend without its broker document", () => {
    undocumented = movement({ from: spy, to: ibkr, amount: 5, day: `${YEAR}-09-08`, kind: "dividend_payout" });
    expect(() => usDividendItems(WINDOW)).toThrow(/has no broker document/);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(undocumented);
  });
});
