import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPanelAccount } from "./createPanelAccount.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { db } from "./db.js";
import { equityTaxLotEventsFromRows, loadEquityTaxLotEvents, type EquityTaxLotRow } from "./equityTaxLotEvents.js";
import { assignOptionContract } from "./optionAssignment.js";
import {
  loadOptionTaxLotEvents,
  optionAssignmentAdjustments,
  optionLotResults,
  optionTaxLotEventsFromRows,
  type OptionTaxLotRow,
} from "./optionTaxLotEvents.js";
import { seedNavTree } from "./seedNavTree.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";
import { realizeTaxLots } from "./taxLots.js";

/** Pure core: rows → events → results, the premium cases of IRC §1234 / Pub. 550. */
const ACC = 7;
let nextId = 1;
function row(on: string, kind: string, amount: number, units: number): OptionTaxLotRow {
  const id = nextId++;
  const transfer = kind !== "option_expire" && kind !== "option_assign";
  const leaves = kind === "option_sell_open" || kind === "option_sell_close";
  return {
    id,
    occurred_on: on,
    account_id: transfer ? null : ACC,
    from_account_id: transfer ? (leaves ? ACC : 99) : null,
    to_account_id: transfer ? (leaves ? 99 : ACC) : null,
    flow_kind: kind,
    amount,
    currency: "usd",
    units_delta: units,
  };
}
const results = (rows: OptionTaxLotRow[]) => optionLotResults(optionTaxLotEventsFromRows(ACC, rows));

describe("optionLotResults", () => {
  it("an expired short is the whole premium as a short-term gain on the expiry day", () => {
    const [r] = results([row("2026-01-05", "option_sell_open", 300, 2), row("2026-02-20", "option_expire", 0, 2)]);
    expect(r).toMatchObject({ side: "short", how: "expired", closedOn: "2026-02-20", openedOn: "2026-01-05", gain: 300, term: "short_term" });
  });

  it("a bought-back short is premium − cost", () => {
    const [r] = results([row("2026-01-05", "option_sell_open", 300, 2), row("2026-01-25", "option_buy_close", 120, 2)]);
    expect(r).toMatchObject({ how: "bought_back", proceeds: 300, cost: 120, gain: 180 });
  });

  it("a long put that expires loses its premium; a sale gives proceeds − cost", () => {
    expect(results([row("2026-01-05", "option_buy_open", 150, 1), row("2026-02-20", "option_expire", 0, 1)])[0]).toMatchObject({
      side: "long",
      how: "expired",
      gain: -150,
    });
    expect(results([row("2026-01-05", "option_buy_open", 150, 1), row("2026-01-30", "option_sell_close", 400, 1)])[0]).toMatchObject({
      how: "sold",
      gain: 250,
    });
  });

  it("a long option held over a year is long-term, a written one never is", () => {
    expect(results([row("2025-01-05", "option_buy_open", 150, 1), row("2026-02-20", "option_sell_close", 400, 1)])[0]!.term).toBe("long_term");
    expect(results([row("2025-01-05", "option_sell_open", 150, 1), row("2026-02-20", "option_buy_close", 40, 1)])[0]!.term).toBe("short_term");
  });

  it("an assignment closes the contract with no gain and carries the premium", () => {
    const [r] = results([row("2026-01-05", "option_sell_open", 300, 2), row("2026-02-20", "option_assign", 0, 2)]);
    expect(r).toMatchObject({ how: "assigned", gain: 0, carried: 300 });
    const [l] = results([row("2026-01-05", "option_buy_open", 90, 1), row("2026-02-20", "option_assign", 0, -1)]);
    expect(l).toMatchObject({ side: "long", how: "exercised", gain: 0, carried: 90 });
  });

  it("splits a partial closing's premium by contracts", () => {
    const rs = results([row("2026-01-05", "option_sell_open", 400, 2), row("2026-01-10", "option_buy_close", 50, 1), row("2026-02-20", "option_expire", 0, 1)]);
    expect(rs.map((r) => [r.how, r.contracts, r.gain])).toEqual([["bought_back", 1, 150], ["expired", 1, 200]]);
  });

  it("fails fast on a closing with nothing open or one that leaves contracts", () => {
    expect(() => results([row("2026-01-05", "option_buy_close", 50, 1)])).toThrow(/position is 0/);
    expect(() => results([row("2026-01-05", "option_sell_open", 300, 2), row("2026-02-20", "option_expire", 0, 1)])).toThrow(/takes 1 contracts/);
    expect(() => results([row("2026-02-20", "option_expire", 0, 1)])).toThrow(/flat position/);
    expect(() => results([{ ...row("2026-01-05", "stock_buy", 1, 1) }])).toThrow(/not an option movement/);
  });
});

/** Equity walk: default adjustments change nothing; given ones move proceeds / cost. */
describe("equityTaxLotEventsFromRows adjustments", () => {
  const stockRows: EquityTaxLotRow[] = [
    { id: 1, occurred_on: "2026-01-01", account_id: null, from_account_id: 9, to_account_id: 5, flow_kind: "stock_buy", amount: 1000, currency: "usd", units_delta: 10 },
    { id: 2, occurred_on: "2026-02-01", account_id: null, from_account_id: 5, to_account_id: 9, flow_kind: "stock_sell", amount: 1200, currency: "usd", units_delta: 10 },
  ];
  it("no adjustments leaves the events identical", () => {
    expect(equityTaxLotEventsFromRows(5, stockRows, new Map())).toEqual(equityTaxLotEventsFromRows(5, stockRows));
    const [d] = realizeTaxLots(equityTaxLotEventsFromRows(5, stockRows).events, "fifo").disposals;
    expect(d!.gain).toBe(200);
  });
  it("adds a premium to proceeds and a delta to cost", () => {
    const [d] = realizeTaxLots(equityTaxLotEventsFromRows(5, stockRows, new Map([[2, 50], [1, -30]])).events, "fifo").disposals;
    expect(d).toMatchObject({ proceeds: 1250, cost: 970, gain: 280 });
  });
});

/** Loader + linked assignments on synthetic accounts (a ticker no market knows). */
const PREFIX = "Vitest · option lots";
const TICKER = "VTOLOT";
const NOTE = "vitest-option-lots";
const created: number[] = [];
function leaf(like: string): number {
  const r = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ESCAPE '\\' LIMIT 1`).get(like) as { id: number } | undefined;
  if (!r) throw new Error(`no leaf ${like}`);
  return r.id;
}
function account(leafId: number, name: string, ticker: string | null): number {
  const id = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`).run(leafId, `${PREFIX} ${name}`, ticker).lastInsertRowid);
  created.push(id);
  return id;
}
function transfer(from: number, to: number, on: string, amount: number, kind: string, units: number | null): number {
  return Number(
    db
      .prepare(`INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind) VALUES (?, ?, ?, 'usd', ?, ?, ?, ?)`)
      .run(from, to, amount, on, NOTE, units, kind).lastInsertRowid
  );
}
function contract(right: "C" | "P", strike: number, expiry: string): number {
  const r = createPanelAccount({
    account: { account_type: "option", name: "", bucket_slug: "brokerage_opciones", option: { underlying: TICKER, right, strike, expiry }, exclude_from_group_totals: false },
  });
  created.push(r.account_id);
  return r.account_id;
}
let cash = 0;
let stock = 0;

beforeAll(() => {
  declareTestInstrument(TICKER);
  cash = account(leaf("%\\_\\_usd"), "USD cash", null);
  stock = account(leaf("brokerage_acciones\\_\\_%"), "stock", TICKER);
  db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 50000, 'usd', '2026-01-02', ?, 'fx_purchase')`).run(cash, NOTE);
});
afterAll(() => {
  for (const a of created) {
    db.prepare(`DELETE FROM option_assignments WHERE option_movement_id IN (SELECT id FROM movements WHERE account_id = ?)`).run(a);
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(a, a, a);
  }
  for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM asset_groups WHERE slug LIKE 'brokerage_opciones\\_\\_vtolot%' ESCAPE '\\'`).run();
  seedNavTree();
  clearAggregationCache();
});

describe("assignments through the ledger", () => {
  it("an assigned short put buys the shares at strike × 100 × n − premium", () => {
    const put = contract("P", 100, "2026-03-20");
    transfer(put, cash, "2026-01-05", 300, "option_sell_open", 2);
    const a = assignOptionContract({ contract_account_id: put, stock_account_id: stock, cash_account_id: cash, occurred_on: "2026-03-10", contracts: 2 });
    expect(a.stock_flow_kind).toBe("stock_buy");
    const adj = optionAssignmentAdjustments(stock);
    expect(adj.get(a.stock_movement_id)).toBe(-300);
    const { events } = loadEquityTaxLotEvents(stock, adj);
    expect(events).toEqual([{ kind: "acquire", date: "2026-03-10", movementId: a.stock_movement_id, units: 200, cost: 20000 - 300 }]);
    expect(loadEquityTaxLotEvents(stock).events[0]).toMatchObject({ cost: 20000 });
    // the contract realizes nothing itself
    expect(optionLotResults(loadOptionTaxLotEvents(put))[0]).toMatchObject({ how: "assigned", gain: 0, carried: 300 });
  });

  it("an assigned short call sells the shares at strike × 100 × n + premium", () => {
    const call = contract("C", 90, "2026-06-19");
    transfer(call, cash, "2026-05-05", 500, "option_sell_open", 1);
    const a = assignOptionContract({ contract_account_id: call, stock_account_id: stock, cash_account_id: cash, occurred_on: "2026-06-10", contracts: 1 });
    expect(a.stock_flow_kind).toBe("stock_sell");
    const adj = optionAssignmentAdjustments(stock);
    expect(adj.get(a.stock_movement_id)).toBe(500);
    const sale = loadEquityTaxLotEvents(stock, adj).events.find((e) => e.kind === "dispose");
    expect(sale).toMatchObject({ units: 100, proceeds: 9000 + 500 });
  });
});
