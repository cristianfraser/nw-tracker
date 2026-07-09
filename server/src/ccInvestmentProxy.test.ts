import {
  describe,
  expect,
  it,
  vi,
  afterEach,
} from "vitest";
import {
  realizedCuotaGains,
  installmentPurchaseToLot,
  normalPurchaseToLot,
  aggregateProxyByFacturacion,
  type ProxyLot,
  type ProxyLotResult,
} from "./ccInvestmentProxy.js";
import * as watchlistStats from "./watchlistStats.js";

// ─── Price-map helpers ────────────────────────────────────────────────────────

type PriceMap = Record<string, number>; // ymd → price

function makePriceLookup(prices: PriceMap) {
  return (ymd: string): { priceClp: number; projected: boolean } => {
    const available = Object.keys(prices).filter((d) => d <= ymd).sort().reverse();
    if (available.length === 0) throw new Error(`No price at ${ymd}`);
    return { priceClp: prices[available[0]!]!, projected: false };
  };
}

// Mirrors computeProxyLot using a price-map; returns ProxyLotResult.
function computeProxyLotWithPrices(
  lot: ProxyLot,
  tickers: string[],
  today: string,
  prices: Record<string, PriceMap>
): ProxyLotResult {
  const by_ticker: ProxyLotResult["by_ticker"] = {};
  for (const ticker of tickers) {
    const priceLookup = makePriceLookup(prices[ticker] ?? {});
    const depositPriceResult = priceLookup(lot.deposit.date);
    const cuotas = realizedCuotaGains(
      depositPriceResult.priceClp,
      depositPriceResult.projected,
      lot.withdrawals,
      priceLookup,
      today
    );
    const gain_clp = cuotas.reduce((s, c) => s + c.realized_gain_clp, 0);
    const principal = lot.withdrawals.reduce((s, w) => s + w.amount_clp, 0);
    by_ticker[ticker] = {
      gain_clp,
      return_pct: principal > 0 ? (gain_clp / principal) * 100 : 0,
      projected: cuotas.some((c) => c.projected),
      cuotas,
    };
  }
  return { by_ticker };
}

// ─── installmentPurchaseToLot ─────────────────────────────────────────────────

describe("installmentPurchaseToLot", () => {
  it("returns null when no payment_statements", () => {
    expect(installmentPurchaseToLot({ principal_clp: 100_000, payment_statements: [] })).toBeNull();
    expect(installmentPurchaseToLot({ principal_clp: 100_000 })).toBeNull();
  });

  it("sets deposit to first pay_by_date, withdrawals sorted, billing_month from pay_by_date", () => {
    const lot = installmentPurchaseToLot({
      principal_clp: 90_000,
      payment_statements: [
        { pay_by_date: "2025-09-08", amount_clp: 30_000 },
        { pay_by_date: "2025-08-08", amount_clp: 30_000 },
        { pay_by_date: "2025-10-08", amount_clp: 30_000 },
      ],
    });
    expect(lot).not.toBeNull();
    expect(lot!.deposit).toEqual({ amount_clp: 90_000, date: "2025-08-08" });
    expect(lot!.withdrawals).toEqual([
      { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-08" },
      { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-09" },
      { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-10" },
    ]);
  });
});

// ─── normalPurchaseToLot ──────────────────────────────────────────────────────

describe("normalPurchaseToLot", () => {
  it("deposit = purchase_on, single withdrawal = pay_by_iso with billing_month", () => {
    const lot = normalPurchaseToLot({
      amount_clp: 50_000,
      purchase_on: "2025-07-15",
      pay_by_iso: "2025-08-08",
      billing_month: "2025-08",
    });
    expect(lot.deposit).toEqual({ amount_clp: 50_000, date: "2025-07-15" });
    expect(lot.withdrawals).toEqual([
      { amount_clp: 50_000, date: "2025-08-08", billing_month: "2025-08" },
    ]);
  });
});

// ─── realizedCuotaGains ───────────────────────────────────────────────────────

describe("realizedCuotaGains", () => {
  const withdrawals: ProxyLot["withdrawals"] = [
    { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-08" },
    { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-09" },
    { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-10" },
  ];

  it("3-cuota rising price: realized_gain_i = cuota × (price_i/depositPrice − 1)", () => {
    const prices: PriceMap = {
      "2025-08-08": 1010,
      "2025-09-08": 1020,
      "2025-10-08": 1030,
    };
    const cuotas = realizedCuotaGains(1000, false, withdrawals, makePriceLookup(prices), "2025-11-01");

    expect(cuotas).toHaveLength(3);

    const g0 = 30_000 * (1010 / 1000 - 1); // 300
    const g1 = 30_000 * (1020 / 1000 - 1); // 600
    const g2 = 30_000 * (1030 / 1000 - 1); // 900

    expect(cuotas[0]!.realized_gain_clp).toBeCloseTo(g0, 2);
    expect(cuotas[1]!.realized_gain_clp).toBeCloseTo(g1, 2);
    expect(cuotas[2]!.realized_gain_clp).toBeCloseTo(g2, 2);

    // accumulated_gain is monotone
    expect(cuotas[0]!.accumulated_gain_clp).toBeCloseTo(g0, 2);
    expect(cuotas[1]!.accumulated_gain_clp).toBeCloseTo(g0 + g1, 2);
    expect(cuotas[2]!.accumulated_gain_clp).toBeCloseTo(g0 + g1 + g2, 2);

    // return% relative to total principal (90k)
    expect(cuotas[2]!.accumulated_return_pct).toBeCloseTo(((g0 + g1 + g2) / 90_000) * 100, 4);

    // all <1% individually
    expect(cuotas[0]!.realized_gain_clp / 30_000).toBeLessThan(0.01 * 1.5); // 1% × fund ≈ 0.01 growth
    expect(cuotas[0]!.projected).toBe(false);
  });

  it("flat price: all gains are zero", () => {
    const prices: PriceMap = { "2025-08-08": 1000, "2025-09-08": 1000, "2025-10-08": 1000 };
    const cuotas = realizedCuotaGains(1000, false, withdrawals, makePriceLookup(prices), "2025-11-01");
    for (const c of cuotas) {
      expect(c.realized_gain_clp).toBeCloseTo(0, 6);
    }
    expect(cuotas[2]!.accumulated_gain_clp).toBeCloseTo(0, 6);
  });

  it("future cuota uses today's price and marks projected=true", () => {
    const prices: PriceMap = {
      "2025-08-08": 1010,
      "2025-09-01": 1050, // "today"
    };
    // cuota[0] is past (2025-08-08 ≤ today), cuota[1] and [2] are future
    const cuotas = realizedCuotaGains(1000, false, withdrawals, makePriceLookup(prices), "2025-09-01");

    expect(cuotas[0]!.projected).toBe(false);
    // cuota[1] date 2025-09-08 > today 2025-09-01 → uses today price 1050
    expect(cuotas[1]!.projected).toBe(true);
    expect(cuotas[1]!.realized_gain_clp).toBeCloseTo(30_000 * (1050 / 1000 - 1), 2);
    // cuota[2] also future
    expect(cuotas[2]!.projected).toBe(true);
  });

  it("depositProjected=true propagates to all cuotas", () => {
    const prices: PriceMap = { "2025-08-08": 1010, "2025-09-08": 1020, "2025-10-08": 1030 };
    const cuotas = realizedCuotaGains(1000, true, withdrawals, makePriceLookup(prices), "2025-11-01");
    for (const c of cuotas) {
      expect(c.projected).toBe(true);
    }
  });
});

// ─── computeProxyLot (price-map engine) ──────────────────────────────────────

describe("computeProxyLot via price-map helper", () => {
  const prices = {
    reserva: {
      "2025-08-08": 1010,
      "2025-09-08": 1020,
      "2025-10-08": 1030,
    },
  };

  it("3-cuota: gain_clp = sum of realized_gain per cuota", () => {
    const lot: ProxyLot = {
      deposit: { amount_clp: 90_000, date: "2025-08-08" },
      withdrawals: [
        { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-08" },
        { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-09" },
        { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-10" },
      ],
    };
    const result = computeProxyLotWithPrices(lot, ["reserva"], "2025-11-01", prices);
    const r = result.by_ticker["reserva"]!;

    const expectedGain =
      30_000 * (1010 / 1010 - 1) + // deposit = first cuota date → 0 gain on first
      30_000 * (1020 / 1010 - 1) +
      30_000 * (1030 / 1010 - 1);

    expect(r.gain_clp).toBeCloseTo(expectedGain, 2);
    expect(r.cuotas).toHaveLength(3);
    expect(r.projected).toBe(false);
  });

  it("normal purchase single withdrawal: gain = amount × (pay_by_price/deposit_price − 1)", () => {
    const normalPrices = { reserva: { "2025-07-15": 1000, "2025-08-08": 1020 } };
    const lot = normalPurchaseToLot({
      amount_clp: 50_000,
      purchase_on: "2025-07-15",
      pay_by_iso: "2025-08-08",
      billing_month: "2025-08",
    });
    const result = computeProxyLotWithPrices(lot, ["reserva"], "2025-08-08", normalPrices);
    const r = result.by_ticker["reserva"]!;
    const expectedGain = 50_000 * (1020 / 1000 - 1); // = 1000
    expect(r.gain_clp).toBeCloseTo(expectedGain, 2);
    expect(r.return_pct).toBeCloseTo((expectedGain / 50_000) * 100, 4); // 2%
  });
});

// ─── aggregateProxyByFacturacion ──────────────────────────────────────────────

describe("aggregateProxyByFacturacion", () => {
  function makeLotResult(cuotaGains: { billing_month: string; amount: number; gain: number }[]): ProxyLotResult {
    let accumulated = 0;
    const principal = cuotaGains.reduce((s, c) => s + c.amount, 0);
    return {
      by_ticker: {
        reserva: {
          gain_clp: cuotaGains.reduce((s, c) => s + c.gain, 0),
          return_pct: 0,
          projected: false,
          cuotas: cuotaGains.map(({ billing_month, amount, gain }) => {
            accumulated += gain;
            return {
              pay_by_date: billing_month + "-08",
              billing_month,
              cuota_amount_clp: amount,
              realized_gain_clp: gain,
              accumulated_gain_clp: accumulated,
              accumulated_return_pct: principal > 0 ? (accumulated / principal) * 100 : 0,
              projected: false,
            };
          }),
        },
      },
    };
  }

  it("distributes 2-cuota purchase across 2 months", () => {
    const lot = makeLotResult([
      { billing_month: "2025-08", amount: 30_000, gain: 300 },
      { billing_month: "2025-09", amount: 30_000, gain: 600 },
    ]);
    const agg = aggregateProxyByFacturacion([lot], ["reserva"]);
    expect(agg).toHaveLength(2);

    const aug = agg.find((a) => a.billing_month === "2025-08")!;
    expect(aug.by_ticker["reserva"]!.total_gain_clp).toBeCloseTo(300, 2);
    expect(aug.by_ticker["reserva"]!.blended_return_pct).toBeCloseTo((300 / 30_000) * 100, 4);

    const sep = agg.find((a) => a.billing_month === "2025-09")!;
    expect(sep.by_ticker["reserva"]!.total_gain_clp).toBeCloseTo(600, 2);
  });

  it("sums multiple purchases in the same month", () => {
    const lot1 = makeLotResult([{ billing_month: "2025-08", amount: 30_000, gain: 300 }]);
    const lot2 = makeLotResult([{ billing_month: "2025-08", amount: 20_000, gain: 200 }]);
    const agg = aggregateProxyByFacturacion([lot1, lot2], ["reserva"]);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.by_ticker["reserva"]!.total_gain_clp).toBeCloseTo(500, 2);
    expect(agg[0]!.by_ticker["reserva"]!.blended_return_pct).toBeCloseTo((500 / 50_000) * 100, 4);
  });

  it("projected=true when any cuota has projected=true", () => {
    const lot = makeLotResult([{ billing_month: "2025-08", amount: 30_000, gain: 300 }]);
    lot.by_ticker["reserva"]!.cuotas[0]!.projected = true;
    const agg = aggregateProxyByFacturacion([lot], ["reserva"]);
    expect(agg[0]!.by_ticker["reserva"]!.projected).toBe(true);
  });
});

// ─── UF-YoY projection (structural test) ─────────────────────────────────────

describe("UF-YoY projection fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ufYoyAnnualRate is used when projecting: 4% over 365 days ≈ ×1.04", () => {
    vi.spyOn(watchlistStats, "ufYoyAnnualRate").mockReturnValue(0.04);
    const rate = watchlistStats.ufYoyAnnualRate();
    expect(rate).toBe(0.04);
    const projected = 1000 * Math.pow(1 + rate!, 365 / 365);
    expect(projected).toBeCloseTo(1040, 0);
  });
});
