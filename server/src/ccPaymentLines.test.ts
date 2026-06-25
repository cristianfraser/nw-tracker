import { describe, expect, it } from "vitest";
import { isCcPaymentMerchant, webPasteAmountClpForDb } from "./ccPaymentLines.js";

describe("ccPaymentLines", () => {
  it("payment merchants are always negative regardless of issuer", () => {
    expect(webPasteAmountClpForDb(5570527, "PAGO", "santander")).toBe(-5570527);
    expect(webPasteAmountClpForDb(-566338, "PAGO", "BCI")).toBe(-566338);
    expect(webPasteAmountClpForDb(-500000, "PAGO")).toBe(-500000);
  });

  it("BCI: charges positive, refunds keep their negative sign", () => {
    expect(webPasteAmountClpForDb(1795575, "TOKU *METLIFE HIPOTE", "BCI")).toBe(1795575);
    expect(webPasteAmountClpForDb(38309, "GLASS LIDER.CL", "BCI")).toBe(38309);
    expect(webPasteAmountClpForDb(-38309, "GLASS LIDER.CL", "BCI")).toBe(-38309);
  });

  it("Santander: charges shown negative become positive, credits become negative", () => {
    expect(webPasteAmountClpForDb(-1990, "ARAMCO", "santander")).toBe(1990);
    expect(webPasteAmountClpForDb(500, "DEVOLUCION X", "santander")).toBe(-500);
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
