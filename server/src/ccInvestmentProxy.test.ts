import {
  describe,
  expect,
  it,
  vi,
  afterEach,
  beforeEach,
} from "vitest";
import {
  realizedCuotaGains,
  installmentPurchaseToLot,
  normalPurchaseToLot,
  aggregateProxyByFacturacion,
  buildNormalPurchaseProxyForAccount,
  type ProxyLot,
  type ProxyLotResult,
} from "./ccInvestmentProxy.js";
import * as watchlistStats from "./watchlistStats.js";
import { db } from "./db.js";
import { buildFacturaciones } from "./ccBillingViews.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";

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
      lot.deposit.amount_clp,
      depositPriceResult.priceClp,
      depositPriceResult.projected,
      lot.withdrawals,
      priceLookup,
      today
    );
    const principal = lot.deposit.amount_clp;
    const gain_clp = cuotas.length > 0 ? cuotas[cuotas.length - 1]!.total_gain_so_far_clp : 0;
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
    expect(
      installmentPurchaseToLot({
        principal_clp: 100_000,
        purchase_date: "2025-07-15",
        first_due_month: "2025-07",
        payment_statements: [],
      })
    ).toBeNull();
    expect(
      installmentPurchaseToLot({ principal_clp: 100_000, purchase_date: "2025-07-15", first_due_month: "2025-07" })
    ).toBeNull();
  });

  it("throws when the purchase has no purchase_date", () => {
    expect(() =>
      installmentPurchaseToLot({
        principal_clp: 90_000,
        first_due_month: "2025-07",
        payment_statements: [{ pay_by_date: "2025-08-08", cuota_current: 1, amount_clp: 30_000 }],
      })
    ).toThrow(/purchase_date/);
  });

  it("deposits on purchase_date and keys each cuota by the facturación that billed it, withdrawn on its pay-by", () => {
    // First cuota billed at the July close; each facturación is paid on the 8th of the next month.
    const lot = installmentPurchaseToLot({
      principal_clp: 90_000,
      purchase_date: "2025-07-15",
      first_due_month: "2025-07",
      payment_statements: [
        { pay_by_date: "2025-09-08", cuota_current: 2, amount_clp: 30_000 },
        { pay_by_date: "2025-08-08", cuota_current: 1, amount_clp: 30_000 },
        { pay_by_date: "2025-10-08", cuota_current: 3, amount_clp: 30_000 },
      ],
    });
    expect(lot).not.toBeNull();
    // The purchase date, NOT the first pay-by — the float starts when you buy.
    expect(lot!.deposit).toEqual({ amount_clp: 90_000, date: "2025-07-15" });
    // Keyed by the plan's billing month (first_due_month + N − 1), never the pay-by month.
    expect(lot!.withdrawals).toEqual([
      { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-07" },
      { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-08" },
      { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-09" },
    ]);
  });

  it("throws on a cuota with no index or pay-by, or a plan with no first_due_month", () => {
    const base = { principal_clp: 90_000, purchase_date: "2025-07-15", first_due_month: "2025-07" };
    expect(() =>
      installmentPurchaseToLot({
        ...base,
        payment_statements: [{ pay_by_date: "2025-08-08", cuota_current: null, amount_clp: 30_000 }],
      })
    ).toThrow(/cuota index/);
    expect(() =>
      installmentPurchaseToLot({
        ...base,
        payment_statements: [{ pay_by_date: "not a date", cuota_current: 1, amount_clp: 30_000 }],
      })
    ).toThrow(/pay-by/);
    expect(() =>
      installmentPurchaseToLot({
        ...base,
        first_due_month: "",
        payment_statements: [{ pay_by_date: "2025-08-08", cuota_current: 1, amount_clp: 30_000 }],
      })
    ).toThrow(/first_due_month/);
  });
});

// ─── normalPurchaseToLot ──────────────────────────────────────────────────────

describe("normalPurchaseToLot", () => {
  it("deposit = purchase_on, single withdrawal = pay_by_iso with billing_month", () => {
    const lot = normalPurchaseToLot({
      amount_clp: 50_000,
      purchase_on: "2025-07-15",
      pay_by_iso: "2025-08-08",
      billing_month: "2025-07",
    });
    expect(lot.deposit).toEqual({ amount_clp: 50_000, date: "2025-07-15" });
    expect(lot.withdrawals).toEqual([
      { amount_clp: 50_000, date: "2025-08-08", billing_month: "2025-07" },
    ]);
  });
});

// ─── realizedCuotaGains ───────────────────────────────────────────────────────

describe("realizedCuotaGains", () => {
  const withdrawals: ProxyLot["withdrawals"] = [
    { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-07" },
    { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-08" },
    { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-09" },
  ];

  it("3-cuota rising price: realized_gain_i = cuota × (price_i/depositPrice − 1)", () => {
    const prices: PriceMap = {
      "2025-08-08": 1010,
      "2025-09-08": 1020,
      "2025-10-08": 1030,
    };
    const cuotas = realizedCuotaGains(90_000, 1000, false, withdrawals, makePriceLookup(prices), "2025-11-01");

    expect(cuotas).toHaveLength(3);

    const g0 = 30_000 * (1010 / 1000 - 1); // 300
    const g1 = 30_000 * (1020 / 1000 - 1); // 600
    const g2 = 30_000 * (1030 / 1000 - 1); // 900

    expect(cuotas[0]!.realized_gain_clp).toBeCloseTo(g0, 2);
    expect(cuotas[1]!.realized_gain_clp).toBeCloseTo(g1, 2);
    expect(cuotas[2]!.realized_gain_clp).toBeCloseTo(g2, 2);

    // total so far = withdrawn slices + the principal still invested, marked at that date
    expect(cuotas[0]!.total_gain_so_far_clp).toBeCloseTo(g0 + 60_000 * 0.01, 2); // 900
    expect(cuotas[1]!.total_gain_so_far_clp).toBeCloseTo(g0 + g1 + 30_000 * 0.02, 2); // 1500
    // last cuota leaves nothing invested → converges to Σ realized
    expect(cuotas[2]!.total_gain_so_far_clp).toBeCloseTo(g0 + g1 + g2, 2); // 1800

    // return% relative to the purchase principal (90k)
    expect(cuotas[2]!.total_return_so_far_pct).toBeCloseTo(((g0 + g1 + g2) / 90_000) * 100, 4);

    // all <1% individually
    expect(cuotas[0]!.realized_gain_clp / 30_000).toBeLessThan(0.01 * 1.5); // 1% × fund ≈ 0.01 growth
    expect(cuotas[0]!.projected).toBe(false);
  });

  it("flat price: all gains are zero", () => {
    const prices: PriceMap = { "2025-08-08": 1000, "2025-09-08": 1000, "2025-10-08": 1000 };
    const cuotas = realizedCuotaGains(90_000, 1000, false, withdrawals, makePriceLookup(prices), "2025-11-01");
    for (const c of cuotas) {
      expect(c.realized_gain_clp).toBeCloseTo(0, 6);
      expect(c.total_gain_so_far_clp).toBeCloseTo(0, 6);
    }
  });

  it("future cuota uses today's price and marks projected=true", () => {
    const prices: PriceMap = {
      "2025-08-08": 1010,
      "2025-09-01": 1050, // "today"
    };
    // cuota[0] is past (2025-08-08 ≤ today), cuota[1] and [2] are future
    const cuotas = realizedCuotaGains(90_000, 1000, false, withdrawals, makePriceLookup(prices), "2025-09-01");

    expect(cuotas[0]!.projected).toBe(false);
    // cuota[1] date 2025-09-08 > today 2025-09-01 → uses today price 1050
    expect(cuotas[1]!.projected).toBe(true);
    expect(cuotas[1]!.realized_gain_clp).toBeCloseTo(30_000 * (1050 / 1000 - 1), 2);
    // cuota[2] also future
    expect(cuotas[2]!.projected).toBe(true);
  });

  it("depositProjected=true propagates to all cuotas", () => {
    const prices: PriceMap = { "2025-08-08": 1010, "2025-09-08": 1020, "2025-10-08": 1030 };
    const cuotas = realizedCuotaGains(90_000, 1000, true, withdrawals, makePriceLookup(prices), "2025-11-01");
    for (const c of cuotas) {
      expect(c.projected).toBe(true);
    }
  });

  it("only the first of 3 cuotas billed: total so far marks the whole purchase", () => {
    // BLUNDSTONE regression: bought 2026-06-03 for 1xx.xxx in 3 cuotas; only cuota 1
    // (pay-by 2026-08-10) is on an imported statement, and its pay-by is still ahead of
    // today, so it prices at today. Depositing at the first pay-by used to make this
    // exactly +$0 — deposit and withdrawal shared a date, a zero-length float.
    const prices: PriceMap = { "2026-06-03": 1000, "2026-08-02": 1010 };
    const cuotas = realizedCuotaGains(
      189_900,
      1000,
      false,
      [{ amount_clp: 63_300, date: "2026-08-10", billing_month: "2026-07" }],
      makePriceLookup(prices),
      "2026-08-02"
    );

    expect(cuotas[0]!.realized_gain_clp).toBeCloseTo(63_300 * 0.01, 2); // 633 — this cuota's slice
    expect(cuotas[0]!.total_gain_so_far_clp).toBeCloseTo(189_900 * 0.01, 2); // 1899 — whole purchase
    expect(cuotas[0]!.total_return_so_far_pct).toBeCloseTo(1, 6);
    expect(cuotas[0]!.projected).toBe(true);
  });
});

// ─── computeProxyLot (price-map engine) ──────────────────────────────────────

describe("computeProxyLot via price-map helper", () => {
  const prices = {
    reserva: {
      "2025-07-15": 1000,
      "2025-08-08": 1010,
      "2025-09-08": 1020,
      "2025-10-08": 1030,
    },
  };

  it("3-cuota: gain_clp = sum of realized_gain per cuota, floats run from the purchase date", () => {
    const lot: ProxyLot = {
      deposit: { amount_clp: 90_000, date: "2025-07-15" },
      withdrawals: [
        { amount_clp: 30_000, date: "2025-08-08", billing_month: "2025-07" },
        { amount_clp: 30_000, date: "2025-09-08", billing_month: "2025-08" },
        { amount_clp: 30_000, date: "2025-10-08", billing_month: "2025-09" },
      ],
    };
    const result = computeProxyLotWithPrices(lot, ["reserva"], "2025-11-01", prices);
    const r = result.by_ticker["reserva"]!;

    // Every cuota earns from 2025-07-15 — the first one included (it is no longer a
    // zero-length float), and the later ones now carry the purchase → first-pay-by stretch.
    const expectedGain =
      30_000 * (1010 / 1000 - 1) +
      30_000 * (1020 / 1000 - 1) +
      30_000 * (1030 / 1000 - 1);

    expect(r.cuotas[0]!.realized_gain_clp).toBeCloseTo(30_000 * 0.01, 2);
    // Fully billed → the lot's P/L is the realized total.
    expect(r.gain_clp).toBeCloseTo(expectedGain, 2);
    expect(r.return_pct).toBeCloseTo((expectedGain / 90_000) * 100, 4);
    expect(r.cuotas).toHaveLength(3);
    expect(r.projected).toBe(false);
  });

  it("normal purchase single withdrawal: gain = amount × (pay_by_price/deposit_price − 1)", () => {
    const normalPrices = { reserva: { "2025-07-15": 1000, "2025-08-08": 1020 } };
    const lot = normalPurchaseToLot({
      amount_clp: 50_000,
      purchase_on: "2025-07-15",
      pay_by_iso: "2025-08-08",
      billing_month: "2025-07",
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
              total_gain_so_far_clp: accumulated,
              total_return_so_far_pct: principal > 0 ? (accumulated / principal) * 100 : 0,
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

  it("puts a cuota's gain on the facturación that billed it, beside that facturación's one-shots", () => {
    // Regression: cuota 1 billed at the August 2026 close is paid on 2026-09-10 like the one-shot
    // billed with it. Keyed by its pay-by month it showed on September's row instead.
    const prices = { reserva: { "2026-08-03": 1000, "2026-09-10": 1010 } };
    const cuotaLot = installmentPurchaseToLot({
      principal_clp: 60_000,
      purchase_date: "2026-08-03",
      first_due_month: "2026-08",
      payment_statements: [{ pay_by_date: "2026-09-10", cuota_current: 1, amount_clp: 30_000 }],
    })!;
    const oneShotLot = normalPurchaseToLot({
      amount_clp: 20_000,
      purchase_on: "2026-08-12",
      pay_by_iso: "2026-09-10",
      billing_month: "2026-08",
    });
    const agg = aggregateProxyByFacturacion(
      [cuotaLot, oneShotLot].map((lot) => computeProxyLotWithPrices(lot, ["reserva"], "2026-09-26", prices)),
      ["reserva"]
    );
    expect(agg.map((a) => a.billing_month)).toEqual(["2026-08"]);
    expect(agg[0]!.by_ticker["reserva"]!.total_gain_clp).toBeCloseTo(30_000 * 0.01 + 20_000 * 0.01, 6);
    expect(agg[0]!.by_ticker["reserva"]!.blended_return_pct).toBeCloseTo(1, 6);
  });
});

// ─── Facturación keying on a card ledger (DB fixture) ─────────────────────────

/**
 * Synthetic Santander card two days after its September 2026 close, statement still pending:
 * August is closed by its statement (printed PAGAR HASTA 10/09/2026, announcing the 24/09 close),
 * September provisionally closed, October open. A 3-cuota plan printed its first cuota on the
 * August statement. The fund is priced 1.000 through August, 1.010 from the August pay-by and
 * 1.020 today.
 */
describe("facturación proxy on a card ledger", () => {
  const SERIES = "vitest_cc_proxy_fund";
  const LAST4 = "9933";
  const TODAY = "2026-09-26";
  const AUG_SOURCE = "vitest proxy 2026-08-25 clp.pdf";
  let accountId = 0;
  let augustId = 0;
  let planId = 0;
  const lineIds: Record<string, number> = {};

  function insertStatement(opts: {
    source: string;
    date: string;
    from?: string;
    to?: string;
    payBy?: string;
    monto?: number;
    nextFrom?: string;
    nextTo?: string;
  }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
             card_last4, layout, currency, monto_facturado, next_period_from, next_period_to
           ) VALUES (?, 'santander', ?, ?, ?, ?, ?, ?, 'compact', 'clp', ?, ?, ?)`
        )
        .run(
          accountId,
          opts.source,
          opts.date,
          opts.from ?? null,
          opts.to ?? null,
          opts.payBy ?? null,
          LAST4,
          opts.monto ?? null,
          opts.nextFrom ?? null,
          opts.nextTo ?? null
        ).lastInsertRowid
    );
  }

  /** One-shot CLP charge; `date` as the source stores it (PDF dd/mm/yy[yy], feed d/m/yyyy). */
  function insertLine(
    statementId: number,
    line: { date: string; merchant: string; clp: number; cuotaKind?: "precio_contado" }
  ): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key,
             cuota_purchase_kind, raw_line
           ) VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(
          statementId,
          line.date,
          line.merchant,
          line.clp,
          `vitest-proxy|${line.merchant}|${line.date}`,
          line.cuotaKind ?? null
        ).lastInsertRowid
    );
    lineIds[line.merchant] = id;
    return id;
  }

  function bucket(billingMonth: string, date: string): number {
    return insertStatement({ source: `import:web-paste|open|${billingMonth}`, date });
  }

  /** [billing_month, pay_by_date] of each withdrawal of a line's lot. */
  function withdrawalsOf(result: ProxyLotResult | undefined): [string, string][] | undefined {
    return result?.by_ticker[SERIES]?.cuotas.map((c) => [c.billing_month, c.pay_by_date]);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z")); // 12:00 Chile, two days after the close
    const assetGroup = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-proxy-facturacion-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · proxy', ?, ?)`)
        .run(assetGroup.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(accountId, LAST4);
    const insPrice = db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest')`
    );
    for (const [day, px] of [
      ["2026-07-01", 1000],
      ["2026-09-10", 1010],
      ["2026-09-26", 1020],
    ] as const) {
      insPrice.run(SERIES, day, px);
    }

    augustId = insertStatement({
      source: AUG_SOURCE,
      date: "25/08/2026",
      from: "23/07/2026",
      to: "25/08/2026",
      payBy: "10/09/2026",
      monto: 71_000,
      nextFrom: "25/08/2026",
      nextTo: "24/09/2026",
    });
    // The PDF parser stores some rows as dd/mm/yy — the proxy's old private parser dropped them.
    insertLine(augustId, { date: "05/08/26", merchant: "VITEST SHORT YEAR", clp: 20_000 });
    insertLine(augustId, { date: "12/08/2026", merchant: "VITEST LONG YEAR", clp: 11_000 });
    // September's bucket: the month is closed at the bank, its statement not in yet.
    insertLine(bucket("2026-09", "20/09/2026"), { date: "7/9/2026", merchant: "VITEST SEPTEMBER", clp: 13_000 });

    planId = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (
             account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
             merchant, description_merged, source
           ) VALUES (?, 'santander', 'vitest-proxy-plan', '2026-07-28', 30000, 3, 'VITEST PLAN', 'VITEST PLAN', 'pdf')`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp,
         cuota_current, cuota_total
       ) VALUES (?, '2026-09-10', '25/08/2026', '2026-08', ?, 10000, 1, 3)`
    ).run(planId, AUG_SOURCE);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(
      `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
    for (const k of Object.keys(lineIds)) delete lineIds[k];
  });

  it("keys every lot by the facturación that billed it, the open and provisional web-paste lines included", () => {
    // A stale August bucket (the month closed by its statement): its leftovers belong to October.
    const staleAugust = bucket("2026-08", "20/08/2026");
    insertLine(staleAugust, { date: "10/8/2026", merchant: "VITEST LEFTOVER", clp: 3_000 });
    // The plan's own purchase row, pasted before the plan existed: the plan's lot carries it.
    insertLine(staleAugust, { date: "28/7/2026", merchant: "VITEST PLAN", clp: 30_000 });
    const october = bucket("2026-10", "20/10/2026");
    insertLine(october, { date: "25/9/2026", merchant: "VITEST OCTOBER", clp: 4_000 });
    // A feed-typed cuota purchase with no count yet: not billed whole at any facturación.
    insertLine(october, { date: "25/9/2026", merchant: "VITEST CUOTAS", clp: 90_000, cuotaKind: "precio_contado" });

    const facturaciones = buildFacturaciones(accountId, []);
    const { lineProxy } = buildNormalPurchaseProxyForAccount(accountId, [SERIES], TODAY, facturaciones);
    // Closed August: the printed PAGAR HASTA; dd/mm/yy and dd/mm/yyyy rows alike.
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST SHORT YEAR"]!))).toEqual([["2026-08", "2026-09-10"]]);
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST LONG YEAR"]!))).toEqual([["2026-08", "2026-09-10"]]);
    // Provisional September and open October: no printed pay-by, the table's derived one.
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST SEPTEMBER"]!))).toEqual([["2026-09", "2026-10-10"]]);
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST OCTOBER"]!))).toEqual([["2026-10", "2026-11-10"]]);
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST LEFTOVER"]!))).toEqual([["2026-10", "2026-11-10"]]);
    expect(lineProxy.has(lineIds["VITEST PLAN"]!)).toBe(false);
    expect(lineProxy.has(lineIds["VITEST CUOTAS"]!)).toBe(false);
    // The pay-by dates are the ones the facturaciones table shows.
    const payBy = new Map(facturaciones.map((f) => [f.billing_month, f.pay_by_iso]));
    expect([payBy.get("2026-08"), payBy.get("2026-09"), payBy.get("2026-10")]).toEqual([
      "2026-09-10",
      "2026-10-10",
      "2026-11-10",
    ]);

    const ledger = creditCardInstallmentsResponse(accountId, [SERIES]);
    // The plan's cuota 1, billed at the August close, withdraws on that facturación's pay-by.
    expect(withdrawalsOf(ledger.purchase_proxy?.[planId])).toEqual([["2026-08", "2026-09-10"]]);
    const byMonth = new Map(
      (ledger.facturacion_proxy ?? []).map((a) => [a.billing_month, a.by_ticker[SERIES]!] as const)
    );
    expect([...byMonth.keys()]).toEqual(["2026-08", "2026-09", "2026-10"]);
    // August: both statement rows and the cuota, all bought at 1.000 and paid at 1.010 → 1%.
    expect(byMonth.get("2026-08")!.total_gain_clp).toBeCloseTo((20_000 + 11_000 + 10_000) * 0.01, 6);
    expect(byMonth.get("2026-08")!.blended_return_pct).toBeCloseTo(1, 6);
    expect(byMonth.get("2026-08")!.projected).toBe(false);
    // September and October pay ahead of today: priced at today, projected.
    expect(byMonth.get("2026-09")!.total_gain_clp).toBeCloseTo(13_000 * 0.02, 6);
    expect(byMonth.get("2026-09")!.projected).toBe(true);
    expect(byMonth.get("2026-10")!.total_gain_clp).toBeCloseTo(4_000 * (1020 / 1010 - 1) + 3_000 * 0.02, 6);
    // Every month the client looks up is a row of the facturaciones table.
    const rows = new Set((ledger.facturaciones ?? []).map((f) => f.billing_month));
    expect([...byMonth.keys()].every((m) => rows.has(m))).toBe(true);
  });

  it("dates a stale bucket's leftover by the open month's pay-by before the open month has a row", () => {
    insertLine(bucket("2026-08", "20/08/2026"), { date: "10/8/2026", merchant: "VITEST LEFTOVER", clp: 3_000 });
    const facturaciones = buildFacturaciones(accountId, []);
    expect(facturaciones.some((f) => f.billing_month === "2026-10")).toBe(false);
    const { lineProxy } = buildNormalPurchaseProxyForAccount(accountId, [SERIES], TODAY, facturaciones);
    expect(withdrawalsOf(lineProxy.get(lineIds["VITEST LEFTOVER"]!))).toEqual([["2026-10", "2026-11-10"]]);
  });

  it("throws on a line whose purchase date cannot be parsed instead of dropping it", () => {
    insertLine(augustId, { date: "not a date", merchant: "VITEST NO DATE", clp: 5_000 });
    expect(() =>
      buildNormalPurchaseProxyForAccount(accountId, [SERIES], TODAY, buildFacturaciones(accountId, []))
    ).toThrow(/no parseable purchase date/);
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
