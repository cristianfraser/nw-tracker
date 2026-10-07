import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { equityBrokerHoldings } from "./equityBrokerHoldings.js";

const PREFIX = "Vitest · broker holdings";
const created: { accounts: number[]; movements: number[] } = { accounts: [], movements: [] };

function leafGroupId(): number {
  const row = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!row) throw new Error("no brokerage_acciones leaf in the test DB");
  return row.id;
}

function account(name: string, ticker: string | null = null): number {
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`)
      .run(leafGroupId(), `${PREFIX} ${name}`, ticker).lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function transfer(from: number, to: number, on: string, units: number, kind: "stock_buy" | "stock_sell"): void {
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

describe("equityBrokerHoldings", () => {
  it("splits one ticker's shares by the cash account that paid, leaving sold-out brokers out", () => {
    const stock = account("stock", "VBRK");
    const brokerA = account("Broker A USD");
    const brokerB = account("Broker B USD");
    const brokerC = account("Broker C USD");

    transfer(brokerA, stock, "2026-01-10", 10, "stock_buy");
    transfer(brokerB, stock, "2026-02-10", 5, "stock_buy");
    transfer(stock, brokerB, "2026-03-10", 2, "stock_sell");
    transfer(brokerC, stock, "2026-03-11", 4, "stock_buy");
    transfer(stock, brokerC, "2026-03-12", 4, "stock_sell");
    created.movements.push(
      Number(
        db
          .prepare(
            `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta)
             VALUES (?, 50, 'usd', '2026-01-05', 'stock_buy', 1)`
          )
          .run(stock).lastInsertRowid
      )
    );
    transfer(brokerB, stock, "2026-05-01", 7, "stock_buy"); // after the as-of date

    const out = equityBrokerHoldings(stock, "2026-04-01", 1_400_000);

    expect(out.map((h) => [h.cash_account_id, h.units])).toEqual([
      [brokerA, 10],
      [brokerB, 3],
      [null, 1],
    ]);
    expect(out[0]!.cash_account_name).toBe(`${PREFIX} Broker A USD`);
    expect(out[2]!.cash_account_name).toBeNull();
    expect(out.reduce((a, h) => a + h.share, 0)).toBeCloseTo(1, 12);
    expect(out[1]!.share).toBeCloseTo(3 / 14, 12);
    expect(out[1]!.value_clp).toBeCloseTo(300_000, 6);
  });

  it("returns nothing for a position with no shares", () => {
    const stock = account("empty stock", "VBRK0");
    expect(equityBrokerHoldings(stock, "2026-04-01", null)).toEqual([]);
  });
});
