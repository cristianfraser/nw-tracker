import { describe, expect, it } from "vitest";
import { realizeTaxLots } from "./taxLots.js";
import { usdCashTaxLotEventsFromRows, type UsdCashTaxLotRow } from "./usdCashTaxLotEvents.js";

const USD = 8001;
const CLP = 8002;
const STOCK = 8003;
const base = { account_id: null, counter_amount: null, counter_currency: null } as const;
const ROWS: UsdCashTaxLotRow[] = [
  // Buy 1.000 dollars for 950.000 pesos on a day the observado is 940.
  { ...base, id: 1, occurred_on: "2026-03-03", from_account_id: CLP, to_account_id: USD, flow_kind: "compra_usd_venta_clp", amount: 950_000, currency: "clp", counter_amount: 1000, counter_currency: "usd" },
  // Spend 600 of them on a stock when the observado is 960.
  { ...base, id: 2, occurred_on: "2026-03-05", from_account_id: USD, to_account_id: STOCK, flow_kind: "stock_buy", amount: 600, currency: "usd" },
  // A 10-dollar dividend arrives at 970.
  { ...base, id: 3, occurred_on: "2026-06-10", from_account_id: STOCK, to_account_id: USD, flow_kind: "dividend_payout", amount: 10, currency: "usd" },
];
const OBSERVADO: Record<string, number> = { "2026-03-03": 940, "2026-03-05": 960, "2026-06-10": 970 };
const observadoOn = (d: string) => OBSERVADO[d]!;

describe("usdCashTaxLotEventsFromRows", () => {
  it("under Oficio 2573 spending dollars on a stock realizes the exchange difference", () => {
    const events = usdCashTaxLotEventsFromRows(USD, ROWS, { posture: "oficio_2573", purchaseCost: "observado", observadoOn });
    const { disposals, openLots } = realizeTaxLots(events, "fifo");
    expect(disposals).toHaveLength(1);
    expect(disposals[0]).toMatchObject({ units: 600, proceeds: 576_000, cost: 564_000, gain: 12_000, tag: "realized" });
    expect(openLots.map((l) => [l.units, l.cost])).toEqual([
      [400, 376_000],
      [10, 9_700],
    ]);
  });

  it("under Oficio 2390 the same purchase is deferred, and pesos paid can be the cost", () => {
    const events = usdCashTaxLotEventsFromRows(USD, ROWS, { posture: "oficio_2390", purchaseCost: "pesos_paid", observadoOn });
    const { disposals } = realizeTaxLots(events, "fifo");
    expect(disposals[0]).toMatchObject({ cost: 570_000, tag: "deferred" });
  });

  it("throws on a movement it does not know", () => {
    const odd: UsdCashTaxLotRow = { ...base, id: 9, occurred_on: "2026-03-06", from_account_id: USD, to_account_id: 1, flow_kind: null, amount: 5, currency: "usd" };
    expect(() =>
      usdCashTaxLotEventsFromRows(USD, [...ROWS, odd], { posture: "oficio_2573", purchaseCost: "observado", observadoOn })
    ).toThrow(/movement 9/);
  });
});
