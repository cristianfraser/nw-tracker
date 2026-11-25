import { describe, expect, it } from "vitest";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import type { CcOwedByCurrency } from "./ccOwedByCurrency.js";
import type { CcCardPayments } from "./dashboardCcUpcomingPayments.js";
import { buildCcGlanceForAccount, ccGlanceFromInputs, type CcGlanceInputs } from "./ccGlance.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { CARD_BILLING_CURRENCY } from "./cards/cardCurrencies.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { ccOwedByCurrency } from "./ccOwedByCurrency.js";
import {
  installmentRemainderAfterFacturacionClp,
  installmentRemainderByFacturacionClp,
} from "./ccInstallmentLedgerDb.js";
import { usdForeign } from "./test/facturadoForeign.js";

function fact(over: Partial<CcFacturacionRow> & Pick<CcFacturacionRow, "billing_month">): CcFacturacionRow {
  return {
    close_date: "",
    close_date_iso: `${over.billing_month}-24`,
    pay_by: null,
    pay_by_iso: null,
    pay_by_source: null,
    facturado: null,
    facturado_foreign: usdForeign(null, null),
    facturado_total: null,
    cuota_a_pagar: null,
    deuda_en_cuotas: null,
    is_open_month: false,
    is_provisional_close: false,
    is_next_cycle: false,
    close_date_source: "statement",
    provisional_estimate_total: null,
    ...over,
  };
}

const TODAY = "2026-10-29";
const RATE = 1000;

// October closed on the 26th (pesos and dollars); November is open: 600.000 of purchases plus a
// 300.000 cuota, US$50. The plans bill 300.000 in November, 200.000 in December, 100.000 in January.
const october = fact({
  billing_month: "2026-10",
  close_date_iso: "2026-10-26",
  pay_by_iso: "2026-11-10",
  pay_by_source: "statement",
  facturado: 2_000_000,
  facturado_foreign: usdForeign(300, 300_000),
  facturado_total: 2_300_000,
});
const november = fact({
  billing_month: "2026-11",
  close_date_iso: "2026-11-24",
  close_date_source: "announced",
  pay_by_iso: "2026-12-10",
  pay_by_source: "derived",
  facturado: 900_000,
  facturado_foreign: usdForeign(50, 50_000),
  facturado_total: 950_000,
  cuota_a_pagar: 300_000,
  is_open_month: true,
});
const remainderByMonth = [
  { billing_month: "2026-11", amount_clp: 300_000 },
  { billing_month: "2026-12", amount_clp: 200_000 },
  { billing_month: "2027-01", amount_clp: 100_000 },
];

function owedFrame(clpLines: number, usdLines: number): CcOwedByCurrency {
  const clp = { facturado: 2_000_000, installment_remainder: 600_000, remaining_cuotas: 6, open_cycle_lines: clpLines };
  return {
    account_id: 1,
    last_closed_billing_month: "2026-10",
    close_iso: "2026-10-26",
    clp: { ...clp, total: clp.facturado + clp.installment_remainder + clpLines },
    foreign: { usd: { facturado: 300, open_cycle_lines: usdLines, total: 300 + usdLines } },
  };
}

const paidOctober: CcCardPayments = {
  paid: { clp: [{ date_iso: "2026-11-05", amount: 2_000_000 }], usd: [{ date_iso: "2026-11-05", amount: 300 }] },
  open_credits: { clp: 0, usd: 0 },
};
const unpaid: CcCardPayments = { paid: { clp: [], usd: [] }, open_credits: { clp: 0, usd: 0 } };

function inputs(over: Partial<CcGlanceInputs>): CcGlanceInputs {
  return {
    accountId: 1,
    billingCurrency: "clp",
    today: TODAY,
    facturaciones: [october, november],
    payments: paidOctober,
    liveRate: () => RATE,
    // The payments of October sit in November's bucket as lines.
    owed: owedFrame(600_000 - 2_000_000, 50 - 300),
    remainderByMonth,
    pendingCuotaPurchases: [],
    nextCycles: [],
    cupos: [
      { currency: "clp", value: 3_000_000 },
      { currency: "usd", value: 1_000 },
    ],
    toBillingCurrency: (qty) => qty * RATE,
    ...over,
  };
}

describe("ccGlanceFromInputs", () => {
  it("two currencies, previous facturación paid: segments add up to the used cupo", () => {
    const g = ccGlanceFromInputs(inputs({}))!;
    expect(g.open).toEqual({
      billing_month: "2026-11",
      total: 950_000,
      amounts: [
        { currency: "clp", amount: 900_000 },
        { currency: "usd", amount: 50 },
      ],
      close_iso: "2026-11-24",
      days_to_close: 26,
    });
    expect(g.previous).toMatchObject({ billing_month: "2026-10", total: 2_300_000, paid: true, owed: [] });
    const [clp, usd] = g.sides;
    expect(clp!.used).toBe(1_200_000);
    expect(clp!.free).toBe(1_800_000);
    expect(clp!.segments!.map((s) => [s.kind, s.billing_month, s.amount])).toEqual([
      ["purchases", "2026-11", 600_000],
      ["cuotas", "2026-11", 300_000],
      ["cuotas", "2026-12", 200_000],
      ["cuotas", "2027-01", 100_000],
    ]);
    expect(clp!.segments!.reduce((s, x) => s + x.amount, 0)).toBe(clp!.used);
    expect(clp!.bracket!.start_share).toBe(0);
    expect(clp!.bracket!.share).toBeCloseTo(0.3);
    expect(clp!.bracket!.amount).toBe(900_000);
    expect(usd).toMatchObject({ currency: "usd", used: 50, total: 1_000, free: 950, segments: null, bracket: null });
    expect(usd!.used_share).toBeCloseTo(0.05);
    expect(g.total_owed).toBe(1_250_000);
  });

  it("a close day: the next cycle's purchases are their own segment, outside the open bracket", () => {
    // November closes today (2026-11-24); 10.000 of purchases dated today already sit in December.
    const december = fact({ billing_month: "2026-12", close_date_iso: "2026-12-24", is_next_cycle: true, facturado: 210_000, cuota_a_pagar: 200_000 });
    const g = ccGlanceFromInputs(
      inputs({
        facturaciones: [october, november, december],
        owed: owedFrame(610_000 - 2_000_000, 50 - 300),
        nextCycles: [{ billing_month: "2026-12", net: 10_000 }],
      })
    )!;
    expect(g.open.billing_month).toBe("2026-11");
    const clp = g.sides[0]!;
    expect(clp.segments!.map((s) => [s.kind, s.billing_month, s.amount])).toEqual([
      ["purchases", "2026-11", 600_000],
      ["cuotas", "2026-11", 300_000],
      ["purchases", "2026-12", 10_000],
      ["cuotas", "2026-12", 200_000],
      ["cuotas", "2027-01", 100_000],
    ]);
    expect(clp.used).toBe(1_210_000);
    expect(clp.bracket!.share).toBeCloseTo(0.3);
  });

  it("a close day whose next cycle holds more credit than purchases lowers the open cycle's purchases", () => {
    // A 15.000 nota beside 10.000 of purchases: the cycle nets −5.000 (its facturado clamps to the cuota).
    const december = fact({ billing_month: "2026-12", close_date_iso: "2026-12-24", is_next_cycle: true, facturado: 200_000, cuota_a_pagar: 200_000 });
    const g = ccGlanceFromInputs(
      inputs({
        facturaciones: [october, november, december],
        owed: owedFrame(595_000 - 2_000_000, 50 - 300),
        nextCycles: [{ billing_month: "2026-12", net: -5_000 }],
      })
    )!;
    expect(g.sides[0]!.segments!.map((s) => [s.kind, s.billing_month, s.amount])).toEqual([
      ["purchases", "2026-11", 595_000],
      ["cuotas", "2026-11", 300_000],
      ["cuotas", "2026-12", 200_000],
      ["cuotas", "2027-01", 100_000],
    ]);
  });

  it("previous facturación unpaid: a grey segment first, what it owes per currency and its pay-by", () => {
    const g = ccGlanceFromInputs(
      inputs({ payments: unpaid, owed: owedFrame(600_000, 50), cupos: [{ currency: "clp", value: 5_000_000 }, { currency: "usd", value: 1_000 }] })
    )!;
    expect(g.previous).toMatchObject({
      paid: false,
      owed: [
        { currency: "clp", amount: 2_000_000 },
        { currency: "usd", amount: 300 },
      ],
      pay_by_iso: "2026-11-10",
      days_to_pay_by: 12,
    });
    const clp = g.sides[0]!;
    expect(clp.segments!.map((s) => [s.kind, s.amount])).toEqual([
      ["previous", 2_000_000],
      ["purchases", 600_000],
      ["cuotas", 300_000],
      ["cuotas", 200_000],
      ["cuotas", 100_000],
    ]);
    expect(clp.used).toBe(3_200_000);
    expect(clp.bracket!.start_share).toBeCloseTo(0.4);
    expect(clp.bracket!.share).toBeCloseTo(0.18);
  });

  it("single-currency card: one side, no bracket label and no sum line", () => {
    const g = ccGlanceFromInputs(
      inputs({
        facturaciones: [
          { ...october, facturado_foreign: [], facturado_total: 2_000_000 },
          { ...november, facturado_foreign: [], facturado_total: 900_000 },
        ],
        payments: { paid: { clp: [{ date_iso: "2026-11-05", amount: 2_000_000 }] }, open_credits: { clp: 0 } },
        owed: { ...owedFrame(600_000 - 2_000_000, 0), foreign: { usd: { facturado: 0, open_cycle_lines: 0, total: 0 } } },
        cupos: [{ currency: "clp", value: 3_000_000 }],
      })
    )!;
    expect(g.sides.map((s) => s.currency)).toEqual(["clp"]);
    expect(g.open.amounts).toEqual([{ currency: "clp", amount: 900_000 }]);
    expect(g.sides[0]!.bracket!.amount).toBeNull();
    expect(g.total_owed).toBeNull();
  });

  it("throws with the figures when the segments do not add up to the used cupo", () => {
    expect(() => ccGlanceFromInputs(inputs({ owed: owedFrame(600_000 - 2_000_000 + 1, 50 - 300) }))).toThrow(
      /segments add up to 1200000 .* uses 1200001/
    );
  });

  it("no open facturación: no block", () => {
    expect(ccGlanceFromInputs(inputs({ facturaciones: [october] }))).toBeNull();
  });
});

describe("buildCcGlanceForAccount (Vitest person)", () => {
  it("every active card's segments add up to its used cupo, and the cuota months to its plan remainder", () => {
    const built: number[] = [];
    for (const accountId of listCreditCardMasterAccountIds()) {
      if (cardStoppedBilling(accountId)) continue;
      const g = buildCcGlanceForAccount(accountId, CARD_BILLING_CURRENCY);
      if (!g) continue;
      built.push(accountId);
      const side = g.sides[0]!;
      expect(side.currency).toBe(g.billing_currency);
      expect(side.segments!.reduce((s, x) => s + x.amount, 0)).toBe(side.used);
      const today = chileCalendarTodayYmd();
      const owed = ccOwedByCurrency(accountId, today);
      const byMonth = installmentRemainderByFacturacionClp(accountId, owed.last_closed_billing_month, today);
      expect(byMonth.reduce((s, m) => s + m.amount_clp, 0)).toBe(
        installmentRemainderAfterFacturacionClp(accountId, owed.last_closed_billing_month, today).amount_clp
      );
    }
    expect(built.length).toBeGreaterThan(0);
  });
});
