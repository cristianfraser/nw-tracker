import { isCcPaymentMerchant } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";

describe("ccPaymentLines", () => {
  it("recognizes payment merchants", () => {
    expect(isCcPaymentMerchant("PAGO")).toBe(true);
    expect(isCcPaymentMerchant("MONTO CANCELADO")).toBe(true);
    expect(isCcPaymentMerchant("ABONO")).toBe(true);
    expect(isCcPaymentMerchant("JUMBO")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABE")).toBe(false);
    expect(isCcPaymentMerchant("PAGO EN LINEA PROM. CMR FALABELLA S.A.")).toBe(false);
  });
});
