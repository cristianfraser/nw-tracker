import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { isClpSection3Merchant, isClpSection3FinancingChargeMerchant } from "./ccStatementSection3.js";
import {
  buildCreditCardFinancingPlByBillingMonth,
} from "./creditCardPerformancePl.js";
import { facturadoClpUsdForStatementSlot } from "./ccBillingViews.js";
import { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";

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
