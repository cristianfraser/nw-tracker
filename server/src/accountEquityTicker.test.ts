import { afterEach, describe, expect, it } from "vitest";
import { accountIdForEquityTicker, accountsWithEquityTickerAtBroker } from "./accountEquityTicker.js";
import { db } from "./db.js";

/**
 * Two accounts may hold one ticker (a Roth IRA's SPY beside the brokerage's): the broker's cash
 * account on the other side of the trades tells them apart.
 */
const PREFIX = "Vitest · ticker lookup";
const TICKER = "VTLK";
const created: { accounts: number[]; movements: number[] } = { accounts: [], movements: [] };

function leafGroupId(): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`).get() as { id: number } | undefined;
  if (!row) throw new Error("no brokerage_acciones leaf in the test DB");
  return row.id;
}

function account(name: string, ticker: string | null = null): number {
  const id = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`).run(leafGroupId(), `${PREFIX} ${name}`, ticker)
      .lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function trade(from: number, to: number, on: string, units: number, kind: "stock_buy" | "stock_sell"): void {
  created.movements.push(
    Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, flow_kind, units_delta)
           VALUES (?, ?, 100, 'usd', ?, ?, ?)`
        )
        .run(from, to, on, kind, units).lastInsertRowid
    )
  );
}

afterEach(() => {
  for (const id of created.movements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
});

describe("accountIdForEquityTicker", () => {
  it("a ticker with one holder resolves with or without a broker", () => {
    const only = account("only holder", TICKER);
    const broker = account("Broker USD");
    expect(accountIdForEquityTicker(TICKER)).toBe(only);
    expect(accountIdForEquityTicker(TICKER, { brokerCashAccountId: broker })).toBe(only);
  });

  it("two holders resolve through the cash account their shares traded against", () => {
    const brokerage = account("brokerage", TICKER);
    const roth = account("roth", TICKER);
    const brokerUsd = account("Broker USD");
    const usChecking = account("US checking");
    const idle = account("Idle USD");
    trade(brokerUsd, brokerage, "2026-01-10", 10, "stock_buy");
    trade(usChecking, roth, "2026-02-10", 5, "stock_buy");
    trade(roth, usChecking, "2026-03-10", 1, "stock_sell");

    expect(() => accountIdForEquityTicker(TICKER)).toThrow(/found 2/);
    expect(accountIdForEquityTicker(TICKER, { brokerCashAccountId: brokerUsd })).toBe(brokerage);
    expect(accountIdForEquityTicker(TICKER, { brokerCashAccountId: usChecking })).toBe(roth);
    expect(accountsWithEquityTickerAtBroker(TICKER, usChecking)).toEqual([roth]);
    // A cash account that traded with neither holder decides nothing.
    expect(() => accountIdForEquityTicker(TICKER, { brokerCashAccountId: idle })).toThrow(/0 of them traded/);
  });

  it("a cash account that traded with both holders is still ambiguous", () => {
    const a = account("holder a", TICKER);
    const b = account("holder b", TICKER);
    const broker = account("Broker USD");
    trade(broker, a, "2026-01-10", 1, "stock_buy");
    trade(broker, b, "2026-01-11", 1, "stock_buy");
    expect(() => accountIdForEquityTicker(TICKER, { brokerCashAccountId: broker })).toThrow(/2 of them traded/);
  });

  it("no holder throws whatever the broker", () => {
    const broker = account("Broker USD");
    expect(() => accountIdForEquityTicker(TICKER, { brokerCashAccountId: broker })).toThrow(/found 0/);
  });
});
