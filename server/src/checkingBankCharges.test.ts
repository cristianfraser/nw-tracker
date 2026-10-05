import { describe, expect, it } from "vitest";
import { checkingMovementFlowKind, isCheckingBankChargeDescription } from "./checkingBankCharges.js";

describe("checking bank charges", () => {
  it("recognises the bank's charge descriptions in either rendering", () => {
    expect(isCheckingBankChargeDescription("COM.MANTENCION PLAN")).toBe(true);
    expect(isCheckingBankChargeDescription("INTERESES LíNEA DE CRéDITO")).toBe(true);
    expect(isCheckingBankChargeDescription("Intereses  Linea de Credito ")).toBe(true);
    expect(isCheckingBankChargeDescription("IMPUESTO SOBREGIRO / USO LCA")).toBe(true);
    expect(isCheckingBankChargeDescription("IMPUESTO SOBREGIRO")).toBe(true);
  });

  it("leaves everything else alone, the tax refunds included", () => {
    expect(isCheckingBankChargeDescription("0608050000 DEV IMPUESTO TESORERIA G")).toBe(false);
    expect(isCheckingBankChargeDescription("CARGO MERCADO CAPITALES")).toBe(false);
    expect(checkingMovementFlowKind("Traspaso a T. Crédito", -100_000)).toBeNull();
  });

  it("tags a debit and refuses a charge description on a credit", () => {
    expect(checkingMovementFlowKind("COM.MANTENCION PLAN", -27_794)).toBe("cash_fee");
    expect(() => checkingMovementFlowKind("COM.MANTENCION PLAN", 27_794)).toThrow(/non-negative/);
  });
});
