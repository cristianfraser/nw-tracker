import { describe, expect, it } from "vitest";
import { ledgerInstallmentsPaid, planInstallmentsConsumed } from "./ccInstallmentLedgerDb.js";

const PR = {
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
  first_due_month: null,
};

function pay(overrides: { amount_clp: number; cuota_current: number | null; cuota_total: number | null }) {
  return {
    id: 1,
    purchase_id: 1,
    pay_by_date: "2026-07-09",
    statement_date: "23/06/2026",
    statement_period_month: "2026-06",
    period_to_join: null,
    source_pdf: "june.pdf",
    parser_row_id: null,
    ...overrides,
  };
}

describe("ledgerInstallmentsPaid", () => {
  it("counts a truly unindexed payment when its amount matches a plan slot", () => {
    // No cuota index at all (current AND total null): the slot-amount match applies.
    const pays = [pay({ amount_clp: 18_661, cuota_current: null, cuota_total: null })];
    expect(ledgerInstallmentsPaid(PR, pays, "2026-07")).toBe(1);
    expect(planInstallmentsConsumed(PR, pays, "2026-07")).toBe(1);
  });

  it("skips cuota-00/N preamble rows (cuota_current null, cuota_total known)", () => {
    // Lider plan-summary preamble: informational, not an actual payment — even when the
    // amount coincides with a cuota slot (semantics from 2026-06-28, e5048c1).
    const pays = [pay({ amount_clp: 18_661, cuota_current: null, cuota_total: 12 })];
    expect(ledgerInstallmentsPaid(PR, pays, "2026-07")).toBe(0);
    expect(planInstallmentsConsumed(PR, pays, "2026-07")).toBe(0);
  });
});
