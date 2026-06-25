import { describe, expect, it } from "vitest";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcFinancingPlMonthRow } from "./creditCardPerformancePl.js";
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
  it("sums facturaciones and recomputes financing YTD on merged series", () => {
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
        },
      ] satisfies CcFacturacionRow[],
      financing_pl_by_month: [
        {
          billing_month: "2025-01",
          statement_charges_clp: 10_000,
          installment_interest_clp: 5_000,
          financing_cost_clp: 15_000,
          ytd_financing_cost_clp: 99,
          cumulative_financing_cost_clp: 99,
        },
      ] satisfies CcFinancingPlMonthRow[],
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
        },
      ] satisfies CcFacturacionRow[],
      financing_pl_by_month: [
        {
          billing_month: "2025-01",
          statement_charges_clp: 3_000,
          installment_interest_clp: 2_000,
          financing_cost_clp: 5_000,
          ytd_financing_cost_clp: 88,
          cumulative_financing_cost_clp: 88,
        },
        {
          billing_month: "2025-02",
          statement_charges_clp: 1_000,
          installment_interest_clp: 0,
          financing_cost_clp: 1_000,
          ytd_financing_cost_clp: 88,
          cumulative_financing_cost_clp: 88,
        },
      ] satisfies CcFinancingPlMonthRow[],
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

    const jan = merged.financing_pl_by_month?.find((r) => r.billing_month === "2025-01");
    const feb = merged.financing_pl_by_month?.find((r) => r.billing_month === "2025-02");
    expect(jan?.financing_cost_clp).toBe(20_000);
    expect(jan?.ytd_financing_cost_clp).toBe(20_000);
    expect(feb?.financing_cost_clp).toBe(1_000);
    expect(feb?.ytd_financing_cost_clp).toBe(21_000);
    expect(feb?.cumulative_financing_cost_clp).toBe(21_000);
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
});

describe("creditCardGroupLedgerResponse", () => {
  it("returns empty ledger for mortgage-only slug", () => {
    const ledger = creditCardGroupLedgerResponse("liabilities_mortgage");
    expect(ledger.account_id).toBe(0);
    expect(ledger.totals.total_remaining_principal_clp).toBe(0);
    expect(ledger.has_installment_ledger).toBe(false);
  });
});
