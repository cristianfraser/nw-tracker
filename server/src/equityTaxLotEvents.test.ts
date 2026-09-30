import { describe, expect, it } from "vitest";
import { equityTaxLotEventsFromRows, type EquityTaxLotRow } from "./equityTaxLotEvents.js";

const ACCOUNT = 7001;
const CASH = 7002;
const row = (over: Partial<EquityTaxLotRow> & Pick<EquityTaxLotRow, "id" | "occurred_on">): EquityTaxLotRow => ({
  account_id: null,
  from_account_id: CASH,
  to_account_id: ACCOUNT,
  flow_kind: "stock_buy",
  amount: 100,
  currency: "usd",
  units_delta: 1,
  ...over,
});

describe("equityTaxLotEventsFromRows", () => {
  it("maps buys, sells and a reinvestment; skips dividends; puts a day's purchases first", () => {
    const { currency, events } = equityTaxLotEventsFromRows(ACCOUNT, [
      row({ id: 4, occurred_on: "2030-06-01", flow_kind: "stock_sell", from_account_id: ACCOUNT, to_account_id: CASH, amount: 1800, units_delta: 41 }),
      row({ id: 3, occurred_on: "2030-05-20", flow_kind: "dividend_payout", from_account_id: ACCOUNT, to_account_id: CASH, amount: 50, units_delta: null }),
      row({ id: 5, occurred_on: "2030-05-20", amount: 50, units_delta: 0.9 }),
      row({ id: 1, occurred_on: "2030-05-02", amount: 2000, units_delta: 40.1 }),
    ]);
    expect(currency).toBe("usd");
    expect(events.map((e) => [e.kind, e.movementId])).toEqual([
      ["acquire", 1],
      ["acquire", 5],
      ["dispose", 4],
    ]);
  });

  it("throws on a movement that is not a trade or dividend, and on mixed currencies", () => {
    expect(() =>
      equityTaxLotEventsFromRows(ACCOUNT, [row({ id: 1, occurred_on: "2026-01-01", flow_kind: null })])
    ).toThrow(/neither a purchase/);
    expect(() =>
      equityTaxLotEventsFromRows(ACCOUNT, [
        row({ id: 1, occurred_on: "2026-01-01" }),
        row({ id: 2, occurred_on: "2026-01-02", currency: "clp" }),
      ])
    ).toThrow(/usd and clp/);
  });

  it("has no currency when the account never traded", () => {
    expect(equityTaxLotEventsFromRows(ACCOUNT, [])).toEqual({ currency: null, events: [] });
  });
});
