import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  installmentInterestClpForCuota,
  type CcInstallmentPurchaseComputed,
} from "./creditCardInstallments.js";
import { isClpSection3Merchant, isClpSection3FinancingChargeMerchant } from "./ccStatementSection3.js";
import {
  buildCreditCardFinancingPlByBillingMonth,
  type CcFinancingPlMonthRow,
} from "./creditCardPerformancePl.js";
import { facturadoClpUsdForStatementSlot } from "./ccBillingViews.js";
import { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";

function synthPurchase(
  overrides: Partial<CcInstallmentPurchaseComputed> & Pick<CcInstallmentPurchaseComputed, "purchase_id">
): CcInstallmentPurchaseComputed {
  return {
    label: "Test",
    principal_clp: 1_000_000,
    installment_count: 12,
    installments_paid: 0,
    cuota_clp: 90_000,
    annual_interest_pct: 0,
    first_due_month: "2025-01",
    schedule_offset_months: 0,
    purchase_month: "2024-12",
    note: null,
    origin: "import_document",
    remaining_installments: 12,
    remaining_principal_clp: 1_000_000,
    next_due_month: "2025-01",
    next_installment_index: 0,
    last_paid_month: null,
    upcoming_cuota_clp: 90_000,
    ...overrides,
  };
}

describe("installmentInterestClpForCuota", () => {
  it("returns 0 when annual interest is 0%", () => {
    expect(installmentInterestClpForCuota(1_000_000, 0, 12, 0, 83_333)).toBe(0);
  });

  it("returns positive interest for rated purchase", () => {
    const interest = installmentInterestClpForCuota(1_000_000, 24, 12, 0, 94_560);
    expect(interest).toBeGreaterThan(0);
  });
});

describe("isClpSection3Merchant", () => {
  it("matches intereses and comisiones merchants", () => {
    expect(isClpSection3Merchant("INTERESES ROTATIVO")).toBe(true);
    expect(isClpSection3Merchant("COMISION MANTENCION")).toBe(true);
    expect(isClpSection3Merchant("SUPERMERCADO XYZ")).toBe(false);
  });

  it("still treats traspaso deuda as section 3 for PDF reconcile", () => {
    expect(isClpSection3Merchant("TRASPASO A DEUDA NACIONAL")).toBe(true);
  });
});

describe("isClpSection3FinancingChargeMerchant", () => {
  it("excludes traspaso deuda nacional from financing cost", () => {
    expect(isClpSection3FinancingChargeMerchant("TRASPASO A DEUDA NACIONAL")).toBe(false);
    expect(isClpSection3FinancingChargeMerchant("TRASPASO DE DEUDA INTERNACIO")).toBe(false);
    expect(isClpSection3FinancingChargeMerchant("INTERESES ROTATIVO")).toBe(true);
  });
});

describe("buildCreditCardFinancingPlByBillingMonth", () => {
  it("sums installment interest into due billing month for rated purchase", () => {
    const purchases = [
      synthPurchase({
        purchase_id: "rated-1",
        annual_interest_pct: 24,
        cuota_clp: 94_560,
        first_due_month: "2025-03",
        installment_count: 6,
        installments_paid: 0,
      }),
    ];
    const rows = buildCreditCardFinancingPlByBillingMonth(999_999, purchases);
    const mar = rows.find((r) => r.billing_month === "2025-03");
    expect(mar).toBeDefined();
    expect(mar!.installment_interest_clp).toBeGreaterThan(0);
    expect(mar!.financing_cost_clp).toBe(mar!.installment_interest_clp);
  });

  it("0% purchase contributes no installment interest", () => {
    const purchases = [
      synthPurchase({
        purchase_id: "free-1",
        annual_interest_pct: 0,
        first_due_month: "2025-04",
      }),
    ];
    const rows = buildCreditCardFinancingPlByBillingMonth(999_999, purchases);
    const apr = rows.find((r) => r.billing_month === "2025-04");
    expect(apr?.installment_interest_clp ?? 0).toBe(0);
  });

  it("computes YTD within calendar year", () => {
    const purchases = [
      synthPurchase({
        purchase_id: "ytd-1",
        annual_interest_pct: 24,
        cuota_clp: 94_560,
        first_due_month: "2025-01",
        installment_count: 3,
      }),
    ];
    const rows = buildCreditCardFinancingPlByBillingMonth(999_999, purchases);
    const jan = rows.find((r) => r.billing_month === "2025-01") as CcFinancingPlMonthRow;
    const feb = rows.find((r) => r.billing_month === "2025-02") as CcFinancingPlMonthRow;
    expect(feb.ytd_financing_cost_clp).toBe(jan.financing_cost_clp + feb.financing_cost_clp);
  });
});

describe("credit card API financing + facturaciones", () => {
  it("4242 Oct 2025 slot facturado uses primary CLP statement", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const slot = statementSlotsByBillingMonth(master.id).get("2025-10");
    if (!slot?.clp) return;

    const { facturado_clp } = facturadoClpUsdForStatementSlot(master.id, slot);
    expect(facturado_clp).toBeGreaterThan(100_000);
  });

  it("builds financing rows for fixture account with statements", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const rows = buildCreditCardFinancingPlByBillingMonth(master.id, []);
    if (rows.length === 0) return;
    expect(rows[0]!.billing_month).toMatch(/^\d{4}-\d{2}$/);
    expect(rows[0]!.financing_cost_clp).toBeGreaterThanOrEqual(0);
  });
});
