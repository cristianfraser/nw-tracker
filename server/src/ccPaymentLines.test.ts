import { describe, expect, it } from "vitest";
import { isCcPaymentMerchant, webPasteAmountClpForDb } from "./ccPaymentLines.js";

describe("ccPaymentLines", () => {
  it("maps web paste signs to DB convention", () => {
    expect(webPasteAmountClpForDb(-1990)).toBe(1990);
    expect(webPasteAmountClpForDb(5570527)).toBe(-5570527);
  });

  it("recognizes payment merchants", () => {
    expect(isCcPaymentMerchant("PAGO")).toBe(true);
    expect(isCcPaymentMerchant("MONTO CANCELADO")).toBe(true);
    expect(isCcPaymentMerchant("JUMBO")).toBe(false);
  });
});
