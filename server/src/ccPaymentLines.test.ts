import { describe, expect, it } from "vitest";
import { isCcPaymentMerchant, webPasteAmountClpForDb } from "./ccPaymentLines.js";

describe("ccPaymentLines", () => {
  it("maps web paste signs to DB convention", () => {
    expect(webPasteAmountClpForDb(-1990, "ARAMCO")).toBe(1990);
    expect(webPasteAmountClpForDb(5570527, "PAGO")).toBe(-5570527);
    expect(webPasteAmountClpForDb(-500000, "PAGO")).toBe(-500000);
    expect(webPasteAmountClpForDb(1795575, "TOKU *METLIFE HIPOTE")).toBe(1795575);
  });

  it("recognizes payment merchants", () => {
    expect(isCcPaymentMerchant("PAGO")).toBe(true);
    expect(isCcPaymentMerchant("MONTO CANCELADO")).toBe(true);
    expect(isCcPaymentMerchant("ABONO")).toBe(true);
    expect(isCcPaymentMerchant("JUMBO")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABE")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABELLA S.A.")).toBe(false);
  });
});
