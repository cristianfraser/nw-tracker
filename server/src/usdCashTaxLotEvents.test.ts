import { describe, expect, it } from "vitest";
import type { UsdWalkRequest, UsdWalkRow } from "./usdCashLotWalk.js";
import { usdCashTaxDisposalsFromRows, type UsdFxPosture, type UsdPurchaseCost } from "./usdCashTaxLotEvents.js";

const USD = 8001;
const CLP = 8002;
const STOCK = 8003;
const CARD = 8004;
const BANK_USD = 8005;
const SCOPE = new Set([USD, BANK_USD]);

function row(r: Partial<UsdWalkRow> & { id: number; occurred_on: string; amount: number; currency: string }): UsdWalkRow {
  return {
    id: r.id,
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

const ROWS: UsdWalkRow[] = [
  // Buy 1.000 dollars for 950.000 pesos on a day the observado is 940.
  row({ id: 1, occurred_on: "2026-03-03", from_account_id: CLP, to_account_id: USD, flow_kind: "compra_usd_venta_clp", amount: 950_000, currency: "clp", counter_amount: 1000, counter_currency: "usd" }),
  // Spend 600 of them on a stock when the observado is 960.
  row({ id: 2, occurred_on: "2026-03-05", from_account_id: USD, to_account_id: STOCK, flow_kind: "stock_buy", amount: 600, currency: "usd", units_delta: 1 }),
  // A 10-dollar dividend arrives at 970.
  row({ id: 3, occurred_on: "2026-06-10", from_account_id: STOCK, to_account_id: USD, flow_kind: "dividend_payout", amount: 10, currency: "usd" }),
];
const OBSERVADO: Record<string, number> = {
  "2026-03-03": 940,
  "2026-03-05": 960,
  "2026-06-10": 970,
  "2026-07-01": 980,
  "2026-07-02": 985,
  "2026-07-03": 990,
  "2026-07-04": 1000,
};
const observadoOn = (d: string) => {
  const v = OBSERVADO[d];
  if (v == null) throw new Error(`no observado for ${d}`);
  return v;
};

function run(
  rows: UsdWalkRow[],
  o: { posture?: UsdFxPosture; purchaseCost?: UsdPurchaseCost; requests?: UsdWalkRequest[]; times?: [number, string][] } = {}
) {
  return usdCashTaxDisposalsFromRows({
    scope: SCOPE,
    rows,
    requests: o.requests ?? [],
    eventTimes: new Map((o.times ?? []).map(([id, at]) => [id, Date.parse(at)])),
    posture: o.posture ?? "oficio_2573",
    purchaseCost: o.purchaseCost ?? "observado",
    observadoOn,
  });
}

describe("usdCashTaxDisposalsFromRows", () => {
  it("under Oficio 2573 spending dollars on a stock realizes the exchange difference", () => {
    const { disposals, openLots } = run(ROWS);
    expect(disposals).toHaveLength(1);
    expect(disposals[0]).toMatchObject({ accountId: USD, movementId: 2, units: 600, proceeds: 576_000, cost: 564_000, gain: 12_000, tag: "realized" });
    expect(disposals[0]!.slices).toEqual([{ acquiredOn: "2026-03-03", acquireMovementId: 1, units: 600, cost: 564_000 }]);
    expect(openLots.map((l) => [l.accountId, l.units, l.cost])).toEqual([
      [USD, 400, 376_000],
      [USD, 10, 9_700],
    ]);
  });

  it("under Oficio 2390 the same purchase is deferred, and pesos paid can be the cost", () => {
    const { disposals } = run(ROWS, { posture: "oficio_2390", purchaseCost: "pesos_paid" });
    expect(disposals[0]).toMatchObject({ cost: 570_000, tag: "deferred" });
  });

  const payment = row({ id: 4, occurred_on: "2026-07-01", from_account_id: USD, to_account_id: CARD, flow_kind: "pago_tarjeta", amount: 100, currency: "usd" });

  it.each([
    ["oficio_2573", "realized"],
    ["oficio_2390", "realized"],
    ["none", "deferred"],
  ] as const)("a card payment in dollars under %s is %s at the observado of its day", (posture, tag) => {
    const { disposals } = run([...ROWS, payment], { posture });
    const d = disposals.find((x) => x.movementId === 4)!;
    expect(d).toMatchObject({ units: 100, proceeds: 98_000, cost: 94_000, gain: 4_000, tag });
  });

  it("a fee leaves at zero proceeds, tagged fee, with the cost it consumed", () => {
    const fee = row({ id: 5, occurred_on: "2026-07-01", account_id: USD, flow_kind: "cash_fee", amount: 10, currency: "usd" });
    const { disposals } = run([...ROWS, fee]);
    expect(disposals.find((x) => x.movementId === 5)).toMatchObject({ units: 10, proceeds: 0, cost: 9_400, gain: -9_400, tag: "fee" });
  });

  it("an own transfer carries the original date and cost, and the destination consumes FIFO", () => {
    const secondBuy = row({ id: 6, occurred_on: "2026-07-01", from_account_id: CLP, to_account_id: USD, flow_kind: "compra_usd_venta_clp", amount: 100_000, currency: "clp", counter_amount: 100, counter_currency: "usd" });
    const wire = row({ id: 7, occurred_on: "2026-07-02", from_account_id: USD, to_account_id: BANK_USD, amount: 510, currency: "usd" });
    const bankPayment = row({ id: 8, occurred_on: "2026-07-03", from_account_id: BANK_USD, to_account_id: CARD, flow_kind: "pago_tarjeta", amount: 450, currency: "usd" });
    const { disposals, openLots } = run([...ROWS, secondBuy, wire, bankPayment]);
    expect(disposals.map((d) => d.movementId)).toEqual([2, 8]);
    const d = disposals[1]!;
    // 400 of the first purchase (at 940), the 10-dollar dividend (at 970), 40 of the second (at 980).
    expect(d.slices).toEqual([
      { acquiredOn: "2026-03-03", acquireMovementId: 1, units: 400, cost: 376_000 },
      { acquiredOn: "2026-06-10", acquireMovementId: 3, units: 10, cost: 9_700 },
      { acquiredOn: "2026-07-01", acquireMovementId: 6, units: 40, cost: 39_200 },
    ]);
    expect(d).toMatchObject({ accountId: BANK_USD, proceeds: 445_500, cost: 424_900, tag: "realized" });
    expect(openLots).toEqual([{ accountId: BANK_USD, acquiredOn: "2026-07-01", acquireMovementId: 6, units: 60, cost: 58_800 }]);
  });

  it("a withdrawal request reserves its dollars, so a buy after it cannot spend them", () => {
    const rows = [
      row({ id: 10, occurred_on: "2026-07-01", from_account_id: CLP, to_account_id: USD, flow_kind: "compra_usd_venta_clp", amount: 98_000, currency: "clp", counter_amount: 100, counter_currency: "usd" }),
      row({ id: 11, occurred_on: "2026-07-02", from_account_id: USD, to_account_id: STOCK, flow_kind: "stock_buy", amount: 10, currency: "usd", units_delta: 1 }),
    ];
    const request: UsdWalkRequest = { message_id: "<r@test>", requested_at: "2026-07-01T20:00:00Z", gross_cents: 10_000, net_cents: 9_000, account_id: USD, booking: null };
    expect(() => run(rows, { requests: [request], times: [[10, "2026-07-01T15:00:00Z"]] })).toThrow(/needs US\$10\.00 but only US\$0\.00/);
  });

  it("a booked withdrawal's fee keeps its own cost; the delivered dollars carry only theirs", () => {
    const rows = [
      row({ id: 20, occurred_on: "2026-07-01", from_account_id: CLP, to_account_id: USD, flow_kind: "compra_usd_venta_clp", amount: 98_000, currency: "clp", counter_amount: 100, counter_currency: "usd" }),
      row({ id: 21, occurred_on: "2026-07-02", account_id: USD, flow_kind: "cash_fee", amount: 10, currency: "usd" }),
      row({ id: 22, occurred_on: "2026-07-02", from_account_id: USD, to_account_id: BANK_USD, amount: 90, currency: "usd" }),
      row({ id: 23, occurred_on: "2026-07-03", from_account_id: BANK_USD, to_account_id: CARD, flow_kind: "pago_tarjeta", amount: 90, currency: "usd" }),
    ];
    const request: UsdWalkRequest = { message_id: "<w@test>", requested_at: "2026-07-01T20:00:00Z", gross_cents: 10_000, net_cents: 9_000, account_id: USD, booking: { transfer_movement_id: 22, fee_movement_id: 21 } };
    const { disposals, openLots } = run(rows, { requests: [request], times: [[20, "2026-07-01T15:00:00Z"]] });
    expect(disposals.map((d) => d.movementId)).toEqual([21, 23]);
    // The fee's 10 dollars cost 10 × 980; the payment's 90 cost 90 × 980 — the fee is not in them.
    expect(disposals[0]).toMatchObject({ tag: "fee", units: 10, proceeds: 0, cost: 9_800, gain: -9_800 });
    expect(disposals[0]!.slices).toEqual([{ acquiredOn: "2026-07-01", acquireMovementId: 20, units: 10, cost: 9_800 }]);
    expect(disposals[1]).toMatchObject({ tag: "realized", units: 90, proceeds: 89_100, cost: 88_200, gain: 900 });
    expect(disposals[1]!.slices).toEqual([{ acquiredOn: "2026-07-01", acquireMovementId: 20, units: 90, cost: 88_200 }]);
    expect(openLots).toEqual([]);
  });

  it("a reconversion to pesos realizes under every posture but none", () => {
    const back = row({ id: 12, occurred_on: "2026-07-04", from_account_id: USD, to_account_id: CLP, amount: 100, currency: "usd", counter_amount: 100_000, counter_currency: "clp" });
    for (const [posture, tag] of [["oficio_2573", "realized"], ["oficio_2390", "realized"], ["none", "deferred"]] as const) {
      const { disposals } = run([...ROWS, back], { posture });
      expect(disposals.find((x) => x.movementId === 12)).toMatchObject({ units: 100, proceeds: 100_000, cost: 94_000, tag });
    }
  });

  it("throws on a movement it does not know", () => {
    const odd = row({ id: 9, occurred_on: "2026-03-06", from_account_id: USD, to_account_id: CARD, flow_kind: null, amount: 5, currency: "eur", counter_amount: 5, counter_currency: "usd" });
    expect(() => run([...ROWS, odd])).toThrow(/movement 9/);
    const noDollars = row({ id: 13, occurred_on: "2026-03-06", account_id: USD, flow_kind: null, amount: 5, currency: "clp" });
    expect(() => run([...ROWS, noDollars])).toThrow(/movement 13/);
  });
});
