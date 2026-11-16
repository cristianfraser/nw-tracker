import { describe, expect, it } from "vitest";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcHistorialChartPoint } from "./creditCardChartSeries.js";
import {
  creditCardGroupLedgerResponse,
  mergeCreditCardLedgers,
} from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { usdForeign } from "./test/facturadoForeign.js";

function ledgerStub(
  partial: Partial<ReturnType<typeof creditCardInstallmentsResponse>>
): ReturnType<typeof creditCardInstallmentsResponse> {
  return {
    account_id: partial.account_id ?? 1,
    billing_currency: partial.billing_currency ?? "clp",
    has_installment_ledger: partial.has_installment_ledger ?? false,
    has_imported_statements: partial.has_imported_statements ?? false,
    meta: partial.meta ?? null,
    purchases: partial.purchases ?? [],
    purchases_completed: partial.purchases_completed ?? [],
    months: partial.months ?? [],
    totals: partial.totals ?? {
      total_remaining_principal: 0,
      next_calendar_month_total: null,
      next_calendar_month: null,
    },
    ...partial,
  };
}

describe("mergeCreditCardLedgers", () => {
  it("sums the credit line over masters and voids the total when one has no configured cupo", () => {
    const a = ledgerStub({
      account_id: 1,
      open_billing_month: "2026-09",
      cupo: { total: 12_000_000, used: 8_000_000, available: 4_000_000, billing_month: "2026-09" },
    });
    const b = ledgerStub({
      account_id: 2,
      open_billing_month: "2026-09",
      cupo: { total: 3_000_000, used: 1_000_000, available: 2_000_000, billing_month: "2026-09" },
    });
    expect(mergeCreditCardLedgers([a, b]).cupo).toEqual({
      total: 15_000_000,
      used: 9_000_000,
      available: 6_000_000,
      billing_month: "2026-09",
    });

    const c = ledgerStub({
      account_id: 3,
      open_billing_month: "2026-09",
      cupo: { total: null, used: 500_000, available: null, billing_month: "2026-09" },
    });
    expect(mergeCreditCardLedgers([a, c]).cupo).toEqual({
      total: null,
      used: 8_500_000,
      available: null,
      billing_month: "2026-09",
    });

    // No master carries a snapshot → the group carries none either.
    expect(mergeCreditCardLedgers([ledgerStub({ account_id: 1 }), ledgerStub({ account_id: 2 })]).cupo).toBeUndefined();
  });

  it("sums facturaciones, totals and card numbers", () => {
    const a = ledgerStub({
      account_id: 1,
      facturaciones: [
        {
          billing_month: "2025-01",
          close_date: "2025-01-20",
          close_date_iso: "2025-01-20",
          pay_by: null,
          pay_by_iso: null,
          pay_by_source: null,
          facturado: 100_000,
          facturado_foreign: usdForeign(null, null),
          facturado_total: 100_000,
          cuota_a_pagar: 50_000,
          deuda_en_cuotas: 120_000,
          is_open_month: false,
          is_provisional_close: false,
          close_date_source: "statement" as const,
          provisional_estimate_total: null,
        },
      ] satisfies CcFacturacionRow[],
      totals: {
        total_remaining_principal: 200_000,
        next_calendar_month: "2025-02",
        next_calendar_month_total: 30_000,
      },
      associated_card_last4s: ["4242"],
    });
    const b = ledgerStub({
      account_id: 2,
      facturaciones: [
        {
          billing_month: "2025-01",
          close_date: "2025-01-21",
          close_date_iso: "2025-01-21",
          pay_by: null,
          pay_by_iso: null,
          pay_by_source: null,
          facturado: 80_000,
          facturado_foreign: usdForeign(null, null),
          facturado_total: 80_000,
          cuota_a_pagar: 20_000,
          deuda_en_cuotas: null,
          is_open_month: false,
          is_provisional_close: false,
          close_date_source: "statement" as const,
          provisional_estimate_total: null,
        },
      ] satisfies CcFacturacionRow[],
      totals: {
        total_remaining_principal: 150_000,
        next_calendar_month: "2025-02",
        next_calendar_month_total: 25_000,
      },
      associated_card_last4s: ["4111"],
    });

    const merged = mergeCreditCardLedgers([a, b]);
    expect(merged.account_id).toBe(0);
    expect(merged.facturaciones?.[0]?.facturado).toBe(180_000);
    expect(merged.facturaciones?.[0]?.cuota_a_pagar).toBe(70_000);
    expect(merged.facturaciones?.[0]?.deuda_en_cuotas).toBe(120_000);
    expect(merged.totals.total_remaining_principal).toBe(350_000);
    expect(merged.totals.next_calendar_month).toBe("2025-02");
    expect(merged.totals.next_calendar_month_total).toBe(55_000);
    expect(merged.associated_card_last4s).toEqual(["4111", "4242"]);
  });

  it("stacks the historial's bars from each card's own bars", () => {
    const detailRow = (overrides: Partial<CcBillingDetailMonthRow>): CcBillingDetailMonthRow => ({
      billing_month: "2026-10",
      as_of_date: "2026-10-01",
      as_of_kind: "manual",
      total_facturado_actual: null,
      total_facturado: null,
      cupo_statement: 0,
      cuota_a_pagar_next_mes: 0,
      balance_statement: 0,
      cupo_en_cuotas: null,
      balance_total: null,
      ...overrides,
    });
    const point = (overrides: Partial<CcHistorialChartPoint>): CcHistorialChartPoint => ({
      month: "2026-10",
      facturado_cuotas: null,
      facturado_rest: null,
      facturado_foreign_total: null,
      facturado_foreign: null,
      facturado_total: null,
      cupo_en_cuotas: null,
      balance_total: null,
      ...overrides,
    });
    const merged = mergeCreditCardLedgers([
      ledgerStub({
        account_id: 1,
        billing_detail_by_month: [detailRow({ total_facturado: 1_000 })],
        historial_chart: [point({ facturado_cuotas: 800, facturado_rest: 200, facturado_total: 1_000 })],
      }),
      ledgerStub({
        account_id: 2,
        billing_detail_by_month: [detailRow({ cuota_a_pagar_next_mes: 30, projected: true })],
        historial_chart: [point({ facturado_cuotas: 30, facturado_total: 30 })],
      }),
    ]);
    expect(merged.historial_chart?.[0]).toMatchObject({
      month: "2026-10",
      facturado_cuotas: 830,
      facturado_rest: 200,
      facturado_foreign_total: null,
      facturado_total: 1_030,
    });
  });

  it("uses statement as_of_kind when any account has a statement row", () => {
    const merged = mergeCreditCardLedgers([
      ledgerStub({
        billing_detail_by_month: [
          {
            billing_month: "2025-03",
            as_of_date: "2025-03-20",
            as_of_kind: "manual",
            total_facturado_actual: 1,
            total_facturado: 1,
            cupo_statement: 10,
            cuota_a_pagar_next_mes: 5,
            balance_statement: 15,
            cupo_en_cuotas: 12,
            balance_total: 17,
          },
        ] satisfies CcBillingDetailMonthRow[],
      }),
      ledgerStub({
        billing_detail_by_month: [
          {
            billing_month: "2025-03",
            as_of_date: "2025-03-21",
            as_of_kind: "statement",
            total_facturado_actual: 2,
            total_facturado: 2,
            cupo_statement: 20,
            cuota_a_pagar_next_mes: 8,
            balance_statement: 28,
            cupo_en_cuotas: 22,
            balance_total: 30,
          },
        ] satisfies CcBillingDetailMonthRow[],
      }),
    ]);
    const row = merged.billing_detail_by_month?.[0];
    expect(row?.as_of_kind).toBe("statement");
    expect(row?.cupo_statement).toBe(30);
    expect(row?.balance_statement).toBe(43);
    // The month frame is never the Σ of the members' own: without the group's sampler it is null.
    expect(row?.cupo_en_cuotas).toBeNull();
    expect(row?.balance_total).toBeNull();
  });

  it("adds a projected card's cuotas to a month another card has already billed", () => {
    const row = (overrides: Partial<CcBillingDetailMonthRow>): CcBillingDetailMonthRow => ({
      billing_month: "2026-10",
      as_of_date: "2026-10-01",
      as_of_kind: "manual",
      total_facturado_actual: null,
      total_facturado: null,
      cupo_statement: 0,
      cuota_a_pagar_next_mes: 0,
      balance_statement: 0,
      cupo_en_cuotas: null,
      balance_total: null,
      ...overrides,
    });
    const open = row({ total_facturado_actual: 1_000, total_facturado: 1_000, cuota_a_pagar_next_mes: 800 });
    const projected = row({ cuota_a_pagar_next_mes: 30, projected: true });
    const merged = mergeCreditCardLedgers([
      ledgerStub({ account_id: 1, billing_detail_by_month: [open] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [projected] }),
    ]).billing_detail_by_month?.[0];
    expect(merged).toMatchObject({ total_facturado: 1_030, total_facturado_actual: 1_000, cuota_a_pagar_next_mes: 830 });
    expect(merged?.projected).toBeUndefined();
    // Both only projected: nothing billed yet, the table keeps reading «≈ Σ cuotas».
    const future = mergeCreditCardLedgers([
      ledgerStub({ account_id: 1, billing_detail_by_month: [row({ cuota_a_pagar_next_mes: 800, projected: true })] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [projected] }),
    ]).billing_detail_by_month?.[0];
    expect(future).toMatchObject({ total_facturado: null, cuota_a_pagar_next_mes: 830, projected: true });
  });

  it("plots the group's «deuda en cuotas» from the month-end sampler, not the merged table column", () => {
    const detailRow = (cupo: number): CcBillingDetailMonthRow => ({
      billing_month: "2025-03",
      as_of_date: "2025-03-20",
      as_of_kind: "statement",
      total_facturado_actual: 100,
      total_facturado: 100,
      cupo_statement: cupo,
      cuota_a_pagar_next_mes: 0,
      balance_statement: 100 + cupo,
      cupo_en_cuotas: cupo + 1,
      balance_total: 100 + cupo + 1,
    });
    const ledgers = [
      ledgerStub({ account_id: 1, billing_detail_by_month: [detailRow(10)] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [detailRow(20)] }),
    ];
    const merged = mergeCreditCardLedgers(ledgers, {
      linesForMonths: (months) => new Map(months.map((m) => [m, { balance_clp: 160, plan_debt: 45 }] as const)),
    });
    expect(merged.billing_detail_by_month?.[0]).toMatchObject({ cupo_statement: 30, balance_statement: 230 });
    expect(merged.historial_chart?.map((p) => [p.month, p.cupo_en_cuotas, p.balance_total])).toEqual([
      ["2025-03", 45, 160],
    ]);
    // The merged table row's month frame is the group's own sample — the chart point — never the
    // Σ of the members' overlaid values (11 + 21).
    expect(merged.billing_detail_by_month?.[0]).toMatchObject({ cupo_en_cuotas: 45, balance_total: 160 });
    // A pure merge (no sampler) plots the merged column and leaves the rows' month frame null.
    const plain = mergeCreditCardLedgers(ledgers);
    expect(plain.historial_chart?.[0]?.cupo_en_cuotas).toBe(30);
    expect(plain.billing_detail_by_month?.[0]).toMatchObject({ cupo_en_cuotas: null, balance_total: null });
  });
});

describe("creditCardGroupLedgerResponse", () => {
  it("returns empty ledger for mortgage-only slug", () => {
    const ledger = creditCardGroupLedgerResponse("liabilities_mortgage");
    expect(ledger.account_id).toBe(0);
    expect(ledger.totals.total_remaining_principal).toBe(0);
    expect(ledger.has_installment_ledger).toBe(false);
  });
});
