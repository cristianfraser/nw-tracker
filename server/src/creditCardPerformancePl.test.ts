import { isClpSection3Merchant, isClpSection3FinancingChargeMerchant } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";

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

