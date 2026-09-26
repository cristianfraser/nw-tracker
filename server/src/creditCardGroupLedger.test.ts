import { describe, expect, it } from "vitest";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcHistorialChartPoint } from "./creditCardChartSeries.js";
import {
  creditCardGroupLedgerResponse,
  mergeCreditCardLedgers,
} from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";

function ledgerStub(
  partial: Partial<ReturnType<typeof creditCardInstallmentsResponse>>
): ReturnType<typeof creditCardInstallmentsResponse> {
  return {
    account_id: partial.account_id ?? 1,
    has_installment_ledger: partial.has_installment_ledger ?? false,
    has_imported_statements: partial.has_imported_statements ?? false,
    meta: partial.meta ?? null,
    purchases: partial.purchases ?? [],
    purchases_completed: partial.purchases_completed ?? [],
    months: partial.months ?? [],
    totals: partial.totals ?? {
      total_remaining_principal_clp: 0,
      next_calendar_month_total_clp: null,
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
      cupo: { total_clp: 12_000_000, used_clp: 8_000_000, available_clp: 4_000_000, billing_month: "2026-09" },
    });
    const b = ledgerStub({
      account_id: 2,
      open_billing_month: "2026-09",
      cupo: { total_clp: 3_000_000, used_clp: 1_000_000, available_clp: 2_000_000, billing_month: "2026-09" },
    });
    expect(mergeCreditCardLedgers([a, b]).cupo).toEqual({
      total_clp: 15_000_000,
      used_clp: 9_000_000,
      available_clp: 6_000_000,
      billing_month: "2026-09",
    });

    const c = ledgerStub({
      account_id: 3,
      open_billing_month: "2026-09",
      cupo: { total_clp: null, used_clp: 500_000, available_clp: null, billing_month: "2026-09" },
    });
    expect(mergeCreditCardLedgers([a, c]).cupo).toEqual({
      total_clp: null,
      used_clp: 8_500_000,
      available_clp: null,
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
          facturado_clp: 100_000,
          facturado_usd: null,
          facturado_usd_clp: null,
          facturado_total_clp: 100_000,
          cuota_a_pagar_clp: 50_000,
          is_open_month: false,
          is_provisional_close: false,
          close_date_source: "statement" as const,
          provisional_estimate_total_clp: null,
          usd_rate_clp: null,
          usd_rate_source: null,
        },
      ] satisfies CcFacturacionRow[],
      totals: {
        total_remaining_principal_clp: 200_000,
        next_calendar_month: "2025-02",
        next_calendar_month_total_clp: 30_000,
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
          facturado_clp: 80_000,
          facturado_usd: null,
          facturado_usd_clp: null,
          facturado_total_clp: 80_000,
          cuota_a_pagar_clp: 20_000,
          is_open_month: false,
          is_provisional_close: false,
          close_date_source: "statement" as const,
          provisional_estimate_total_clp: null,
          usd_rate_clp: null,
          usd_rate_source: null,
        },
      ] satisfies CcFacturacionRow[],
      totals: {
        total_remaining_principal_clp: 150_000,
        next_calendar_month: "2025-02",
        next_calendar_month_total_clp: 25_000,
      },
      associated_card_last4s: ["4111"],
    });

    const merged = mergeCreditCardLedgers([a, b]);
    expect(merged.account_id).toBe(0);
    expect(merged.facturaciones?.[0]?.facturado_clp).toBe(180_000);
    expect(merged.facturaciones?.[0]?.cuota_a_pagar_clp).toBe(70_000);
    expect(merged.totals.total_remaining_principal_clp).toBe(350_000);
    expect(merged.totals.next_calendar_month).toBe("2025-02");
    expect(merged.totals.next_calendar_month_total_clp).toBe(55_000);
    expect(merged.associated_card_last4s).toEqual(["4111", "4242"]);
  });

  it("stacks the historial's bars from each card's own bars", () => {
    const detailRow = (overrides: Partial<CcBillingDetailMonthRow>): CcBillingDetailMonthRow => ({
      billing_month: "2026-10",
      as_of_date: "2026-10-01",
      as_of_kind: "manual",
      total_facturado_actual_clp: null,
      total_facturado_clp: null,
      cupo_en_cuotas_clp: 0,
      cuota_a_pagar_next_mes_clp: 0,
      balance_total_clp: 0,
      ...overrides,
    });
    const point = (overrides: Partial<CcHistorialChartPoint>): CcHistorialChartPoint => ({
      month: "2026-10",
      facturado_cuotas_clp: null,
      facturado_rest_clp: null,
      facturado_usd_clp: null,
      facturado_usd: null,
      facturado_total_clp: null,
      cupo_en_cuotas_clp: null,
      balance_total_clp: null,
      ...overrides,
    });
    const merged = mergeCreditCardLedgers([
      ledgerStub({
        account_id: 1,
        billing_detail_by_month: [detailRow({ total_facturado_clp: 1_000 })],
        historial_chart: [point({ facturado_cuotas_clp: 800, facturado_rest_clp: 200, facturado_total_clp: 1_000 })],
      }),
      ledgerStub({
        account_id: 2,
        billing_detail_by_month: [detailRow({ cuota_a_pagar_next_mes_clp: 30, projected: true })],
        historial_chart: [point({ facturado_cuotas_clp: 30, facturado_total_clp: 30 })],
      }),
    ]);
    expect(merged.historial_chart?.[0]).toMatchObject({
      month: "2026-10",
      facturado_cuotas_clp: 830,
      facturado_rest_clp: 200,
      facturado_usd_clp: null,
      facturado_total_clp: 1_030,
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
            total_facturado_actual_clp: 1,
            total_facturado_clp: 1,
            cupo_en_cuotas_clp: 10,
            cuota_a_pagar_next_mes_clp: 5,
            balance_total_clp: 15,
          },
        ] satisfies CcBillingDetailMonthRow[],
      }),
      ledgerStub({
        billing_detail_by_month: [
          {
            billing_month: "2025-03",
            as_of_date: "2025-03-21",
            as_of_kind: "statement",
            total_facturado_actual_clp: 2,
            total_facturado_clp: 2,
            cupo_en_cuotas_clp: 20,
            cuota_a_pagar_next_mes_clp: 8,
            balance_total_clp: 28,
          },
        ] satisfies CcBillingDetailMonthRow[],
      }),
    ]);
    const row = merged.billing_detail_by_month?.[0];
    expect(row?.as_of_kind).toBe("statement");
    expect(row?.cupo_en_cuotas_clp).toBe(30);
    expect(row?.balance_total_clp).toBe(43);
  });

  it("adds a projected card's cuotas to a month another card has already billed", () => {
    const row = (overrides: Partial<CcBillingDetailMonthRow>): CcBillingDetailMonthRow => ({
      billing_month: "2026-10",
      as_of_date: "2026-10-01",
      as_of_kind: "manual",
      total_facturado_actual_clp: null,
      total_facturado_clp: null,
      cupo_en_cuotas_clp: 0,
      cuota_a_pagar_next_mes_clp: 0,
      balance_total_clp: 0,
      ...overrides,
    });
    const open = row({ total_facturado_actual_clp: 1_000, total_facturado_clp: 1_000, cuota_a_pagar_next_mes_clp: 800 });
    const projected = row({ cuota_a_pagar_next_mes_clp: 30, projected: true });
    const merged = mergeCreditCardLedgers([
      ledgerStub({ account_id: 1, billing_detail_by_month: [open] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [projected] }),
    ]).billing_detail_by_month?.[0];
    expect(merged).toMatchObject({ total_facturado_clp: 1_030, total_facturado_actual_clp: 1_000, cuota_a_pagar_next_mes_clp: 830 });
    expect(merged?.projected).toBeUndefined();
    // Both only projected: nothing billed yet, the table keeps reading «≈ Σ cuotas».
    const future = mergeCreditCardLedgers([
      ledgerStub({ account_id: 1, billing_detail_by_month: [row({ cuota_a_pagar_next_mes_clp: 800, projected: true })] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [projected] }),
    ]).billing_detail_by_month?.[0];
    expect(future).toMatchObject({ total_facturado_clp: null, cuota_a_pagar_next_mes_clp: 830, projected: true });
  });

  it("plots the group's «deuda en cuotas» from the month-end sampler, not the merged table column", () => {
    const detailRow = (cupo: number): CcBillingDetailMonthRow => ({
      billing_month: "2025-03",
      as_of_date: "2025-03-20",
      as_of_kind: "statement",
      total_facturado_actual_clp: 100,
      total_facturado_clp: 100,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: 0,
      balance_total_clp: 100 + cupo,
    });
    const ledgers = [
      ledgerStub({ account_id: 1, billing_detail_by_month: [detailRow(10)] }),
      ledgerStub({ account_id: 2, billing_detail_by_month: [detailRow(20)] }),
    ];
    const merged = mergeCreditCardLedgers(ledgers, {
      installmentDebtForMonths: (months) => new Map(months.map((m) => [m, 45] as const)),
    });
    expect(merged.billing_detail_by_month?.[0]?.cupo_en_cuotas_clp).toBe(30);
    expect(merged.historial_chart?.map((p) => [p.month, p.cupo_en_cuotas_clp])).toEqual([["2025-03", 45]]);
    // A pure merge (no sampler) plots the merged column.
    expect(mergeCreditCardLedgers(ledgers).historial_chart?.[0]?.cupo_en_cuotas_clp).toBe(30);
  });
});

describe("creditCardGroupLedgerResponse", () => {
  it("returns empty ledger for mortgage-only slug", () => {
    const ledger = creditCardGroupLedgerResponse("liabilities_mortgage");
    expect(ledger.account_id).toBe(0);
    expect(ledger.totals.total_remaining_principal_clp).toBe(0);
    expect(ledger.has_installment_ledger).toBe(false);
  });
});
