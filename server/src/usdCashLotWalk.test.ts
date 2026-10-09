import { describe, expect, it } from "vitest";
import { walkUsdCashLots, type UsdWalkInput, type UsdWalkRequest, type UsdWalkRow } from "./usdCashLotWalk.js";

const USD_A = 9101;
const USD_B = 9102;
const CLP = 9103;
const STOCK = 9104;
const CARD = 9105;
const SCOPE = new Set([USD_A, USD_B]);

let nextId = 1;
function row(r: Partial<UsdWalkRow> & { occurred_on: string; amount: number; currency: string }): UsdWalkRow {
  return {
    id: r.id ?? nextId++,
    account_id: r.account_id ?? null,
    from_account_id: r.from_account_id ?? null,
    to_account_id: r.to_account_id ?? null,
    amount: r.amount,
    currency: r.currency,
    counter_amount: r.counter_amount ?? null,
    counter_currency: r.counter_currency ?? null,
    occurred_on: r.occurred_on,
    note: null,
    units_delta: r.units_delta ?? null,
    flow_kind: r.flow_kind ?? null,
    ticker: null,
  };
}
const buyUsd = (on: string, to: number, usd: number, clp: number, id?: number) =>
  row({ id, occurred_on: on, from_account_id: CLP, to_account_id: to, amount: clp, currency: "clp", counter_amount: usd, counter_currency: "usd", flow_kind: "compra_usd_venta_clp" });
const spend = (on: string, from: number, to: number, usd: number, flow_kind: string | null, id?: number) =>
  row({ id, occurred_on: on, from_account_id: from, to_account_id: to, amount: usd, currency: "usd", flow_kind, units_delta: flow_kind === "stock_buy" ? 1 : null });

/** Purchases at their pesos, anything else at 1.000 pesos per dollar. */
const price: UsdWalkInput["priceInflow"] = ({ row: r, cents, source }) => (source === "purchase" ? r.amount : cents * 10);

const walk = (rows: UsdWalkRow[], requests: UsdWalkRequest[] = [], eventTimes: [number, string][] = [], feeCostToNet = true) =>
  walkUsdCashLots({
    scope: SCOPE,
    rows,
    requests,
    eventTimes: new Map(eventTimes.map(([id, at]) => [id, Date.parse(at)])),
    priceInflow: price,
    feeCostToNet,
  });

describe("walkUsdCashLots", () => {
  it("consumes FIFO across purchases and reports the slices", () => {
    const r = walk([buyUsd("2097-01-01", USD_A, 100, 90_000), buyUsd("2097-01-02", USD_A, 100, 100_000), spend("2097-01-03", USD_A, CARD, 150, "pago_tarjeta")]);
    expect(r.outflows).toHaveLength(1);
    expect(r.outflows[0]!.slices.map((s) => [s.acquiredOn, s.cents, s.clp, s.source])).toEqual([
      ["2097-01-01", 10_000, 90_000, "purchase"],
      ["2097-01-02", 5_000, 50_000, "purchase"],
    ]);
    expect(r.queues.get(USD_A)!.map((s) => [s.cents, s.clp])).toEqual([[5_000, 50_000]]);
    expect(r.inflows.map((i) => i.source)).toEqual(["purchase", "purchase"]);
  });

  it("carries an own transfer's slices intact and marks them with the transfer", () => {
    const wire = spend("2097-01-03", USD_A, USD_B, 150, null, 50);
    const r = walk([buyUsd("2097-01-01", USD_A, 100, 90_000, 1), buyUsd("2097-01-02", USD_A, 100, 100_000, 2), wire, spend("2097-01-04", USD_B, CARD, 120, "pago_tarjeta", 60)]);
    const [transfer, payment] = r.outflows;
    expect(transfer!.carriedTo).toBe(USD_B);
    expect(payment!.carriedTo).toBeNull();
    expect(payment!.slices.map((s) => [s.acquiredOn, s.acquireMovementId, s.cents, s.clp, s.carriedBy])).toEqual([
      ["2097-01-01", 1, 10_000, 90_000, 50],
      ["2097-01-02", 2, 2_000, 20_000, 50],
    ]);
    expect(r.queues.get(USD_B)!.map((s) => s.cents)).toEqual([3_000]);
    expect(r.queues.get(USD_A)!.map((s) => s.cents)).toEqual([5_000]);
    // An own transfer is not an acquisition.
    expect(r.inflows).toHaveLength(2);
  });

  it("prices a market inflow through the callback and lists rows that move no dollars", () => {
    const dividend = row({ occurred_on: "2097-02-01", from_account_id: STOCK, to_account_id: USD_A, amount: 10, currency: "usd", flow_kind: "dividend_payout" });
    const noDollars = row({ occurred_on: "2097-02-02", account_id: USD_A, amount: 5, currency: "clp" });
    const r = walk([dividend, noDollars]);
    expect(r.inflows[0]).toMatchObject({ source: "market", cents: 1_000, clp: 10_000 });
    expect(r.skippedRows.map((x) => x.id)).toEqual([noDollars.id]);
  });

  it("lets a timeless day's arrivals fund its spending, whatever the ids", () => {
    const r = walk([spend("2097-03-01", USD_A, STOCK, 100, "stock_buy", 2), buyUsd("2097-03-01", USD_A, 100, 95_000, 3)]);
    expect(r.outflows[0]!.slices.map((s) => s.clp)).toEqual([95_000]);
  });

  it("orders a day that carries a request by time (and arrivals first by id without one)", () => {
    const rows = [buyUsd("2097-03-01", USD_A, 100, 90_000, 1), buyUsd("2097-03-01", USD_A, 100, 100_000, 2), spend("2097-03-01", USD_A, CARD, 100, "pago_tarjeta", 3)];
    const times: [number, string][] = [[1, "2097-03-01T15:00:00Z"], [2, "2097-03-01T12:00:00Z"], [3, "2097-03-01T13:00:00Z"]];
    const request: UsdWalkRequest = { message_id: "<r@test>", requested_at: "2097-03-01T16:00:00Z", gross_cents: 5_000, net_cents: 5_000, account_id: USD_A, booking: null };
    const timed = walk(rows, [request], times);
    // By time, purchase 2 is the only one on hand when the payment runs; the request then reserves from purchase 1.
    expect(timed.outflows[0]!.slices.map((s) => [s.acquireMovementId, s.clp])).toEqual([[2, 100_000]]);
    expect(timed.reservations.get("<r@test>")!.net.map((s) => [s.acquireMovementId, s.cents])).toEqual([[1, 5_000]]);
    // Without a request the times do not order the day: arrivals first, then by id.
    expect(walk(rows, [], times).outflows[0]!.slices.map((s) => s.acquireMovementId)).toEqual([1]);
  });

  it("throws on a shortfall above one cent", () => {
    expect(() => walk([buyUsd("2097-01-01", USD_A, 100, 90_000), spend("2097-01-02", USD_A, CARD, 200, "pago_tarjeta")])).toThrow(
      /needs US\$200\.00 but only US\$100\.00/
    );
  });

  describe("withdrawal requests", () => {
    const request = (o: Partial<UsdWalkRequest> & { gross: number; net: number }): UsdWalkRequest => ({
      message_id: o.message_id ?? "<req@test>",
      requested_at: o.requested_at ?? "2097-04-01T18:00:00Z",
      gross_cents: o.gross * 100,
      net_cents: o.net * 100,
      account_id: USD_A,
      booking: o.booking ?? null,
    });

    it("reserves the gross FIFO at request time so a later buy cannot spend it", () => {
      const rows = [buyUsd("2097-04-01", USD_A, 100, 90_000, 1), spend("2097-04-02", USD_A, STOCK, 10, "stock_buy", 2)];
      expect(() => walk(rows, [request({ gross: 100, net: 100 })], [[1, "2097-04-01T12:00:00Z"]])).toThrow(/needs US\$10\.00 but only US\$0\.00/);
    });

    it("refuses a request day whose other events on the account have no time", () => {
      const rows = [buyUsd("2097-04-01", USD_A, 100, 90_000, 1)];
      expect(() => walk(rows, [request({ gross: 50, net: 50 })])).toThrow(/has no time/);
    });

    it("hands the net all the reserved pesos and the fee none, whatever the order of the booked rows", () => {
      const rows = [
        buyUsd("2097-04-01", USD_A, 50, 45_000, 1),
        buyUsd("2097-04-01", USD_A, 50, 50_000, 2),
        // The fee is written before the wire.
        row({ id: 3, occurred_on: "2097-04-03", account_id: USD_A, amount: 10, currency: "usd", flow_kind: "cash_fee" }),
        spend("2097-04-03", USD_A, USD_B, 90, null, 4),
        spend("2097-04-04", USD_B, CARD, 90, "pago_tarjeta", 5),
      ];
      const r = walk(rows, [request({ gross: 100, net: 90, booking: { transfer_movement_id: 4, fee_movement_id: 3 } })], [[1, "2097-04-01T12:00:00Z"], [2, "2097-04-01T12:30:00Z"]]);
      const fee = r.outflows.find((o) => o.row.id === 3)!;
      const wire = r.outflows.find((o) => o.row.id === 4)!;
      const payment = r.outflows.find((o) => o.row.id === 5)!;
      expect(fee.draw).toEqual({ message_id: "<req@test>", role: "fee" });
      // The fee takes the LAST reserved dollars (purchase 2), at no pesos.
      expect(fee.slices.map((s) => [s.acquireMovementId, s.cents, s.clp])).toEqual([[2, 1_000, 0]]);
      expect(wire.draw).toEqual({ message_id: "<req@test>", role: "transfer" });
      expect(wire.slices.reduce((s, x) => s + x.clp, 0)).toBeCloseTo(95_000, 6);
      expect(wire.slices.map((s) => [s.acquireMovementId, s.cents])).toEqual([[1, 5_000], [2, 4_000]]);
      expect(payment.slices.map((s) => [s.acquireMovementId, s.acquiredOn, s.carriedBy])).toEqual([[1, "2097-04-01", 4], [2, "2097-04-01", 4]]);
      expect(payment.slices.reduce((s, x) => s + x.clp, 0)).toBeCloseTo(95_000, 6);
      expect(r.queues.get(USD_A) ?? []).toEqual([]);
    });

    it("without feeCostToNet every reserved slice keeps its own pesos", () => {
      const rows = [
        buyUsd("2097-04-01", USD_A, 50, 45_000, 1),
        buyUsd("2097-04-01", USD_A, 50, 50_000, 2),
        row({ id: 3, occurred_on: "2097-04-03", account_id: USD_A, amount: 10, currency: "usd", flow_kind: "cash_fee" }),
        spend("2097-04-03", USD_A, USD_B, 90, null, 4),
      ];
      const r = walk(rows, [request({ gross: 100, net: 90, booking: { transfer_movement_id: 4, fee_movement_id: 3 } })], [[1, "2097-04-01T12:00:00Z"], [2, "2097-04-01T12:30:00Z"]], false);
      const fee = r.outflows.find((o) => o.row.id === 3)!;
      const wire = r.outflows.find((o) => o.row.id === 4)!;
      expect(fee.slices.map((s) => [s.acquireMovementId, s.cents, s.clp])).toEqual([[2, 1_000, 10_000]]);
      expect(wire.slices.map((s) => [s.acquireMovementId, s.cents, s.clp])).toEqual([[1, 5_000, 45_000], [2, 4_000, 40_000]]);
      expect(r.queues.get(USD_B)!.reduce((s, x) => s + x.clp, 0)).toBe(85_000);
    });

    it("throws when a booked reservation does not end empty", () => {
      const rows = [buyUsd("2097-04-01", USD_A, 100, 90_000, 1), spend("2097-04-03", USD_A, USD_B, 90, null, 4)];
      expect(() =>
        walk(rows, [request({ gross: 100, net: 90, booking: { transfer_movement_id: 4, fee_movement_id: 3 } })], [[1, "2097-04-01T12:00:00Z"]])
      ).toThrow(/US\$10\.00 of the reserved gross unaccounted for/);
    });

    it("throws when the booked transfer moves something other than the net", () => {
      const rows = [buyUsd("2097-04-01", USD_A, 100, 90_000, 1), spend("2097-04-03", USD_A, USD_B, 95, null, 4)];
      expect(() =>
        walk(rows, [request({ gross: 100, net: 100, booking: { transfer_movement_id: 4, fee_movement_id: null } })], [[1, "2097-04-01T12:00:00Z"]])
      ).toThrow(/moves US\$95\.00, not its net US\$100\.00/);
    });
  });
});
