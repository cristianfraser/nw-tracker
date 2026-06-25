import { describe, expect, it } from "vitest";
import { ledgerInstallmentsPaid, planInstallmentsConsumed } from "./ccInstallmentLedgerDb.js";

describe("ledgerInstallmentsPaid", () => {
  it("counts unindexed PDF cuota payment when amount matches plan slot", () => {
    const pr = {
      id: 1,
      canonical_row_id: "x",
      card_group: "A",
      purchase_date: "2026-05-27",
      total_amount_clp: 223_930,
      cuotas_totales: 12,
      merchant: "CLINICA ARCAYA",
      description_merged: null,
      matched_baseline_purchase_id: null,
      source: "pdf",
    };
    const pays = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-07-09",
        statement_date: "23/06/2026",
        statement_period_month: "2026-06",
        period_to_join: null,
        source_pdf: "june.pdf",
        amount_clp: 18_661,
        cuota_current: null,
        cuota_total: 12,
        parser_row_id: null,
      },
    ];
    expect(ledgerInstallmentsPaid(pr, pays, "2026-07")).toBe(1);
    expect(planInstallmentsConsumed(pr, pays, "2026-07")).toBe(1);
  });
});
