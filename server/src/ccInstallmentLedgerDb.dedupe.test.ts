import { describe, expect, it } from "vitest";
import { dedupeInstallmentPurchaseLedgerRows } from "./ccInstallmentLedgerDb.js";

describe("dedupeInstallmentPurchaseLedgerRows", () => {
  it("keeps one row per purchase stem and prefers non-summary merchant", () => {
    const rows = dedupeInstallmentPurchaseLedgerRows([
      {
        id: 465,
        purchase_date: "2025-02-27",
        total_amount_clp: 881_134,
        cuotas_totales: 12,
        merchant: "ROCA WEBPAY N/CUOTAS PRECIO",
      },
      {
        id: 431,
        purchase_date: "2025-02-27",
        total_amount_clp: 881_134,
        cuotas_totales: 12,
        merchant: "ROCA WEBPAY",
      },
      {
        id: 478,
        purchase_date: "2025-02-27",
        total_amount_clp: 881_134,
        cuotas_totales: 12,
        merchant: "ROCA WEBPAY",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.merchant).toBe("ROCA WEBPAY");
    expect(rows[0]?.id).toBe(478);
  });

  it("dedupes rows when merchant spacing differs", () => {
    const rows = dedupeInstallmentPurchaseLedgerRows([
      {
        id: 13,
        purchase_date: "2025-02-07",
        total_amount_clp: 54_990,
        cuotas_totales: 6,
        merchant: "MP     *MERCADO LIBRE",
      },
      {
        id: 59,
        purchase_date: "2025-02-07",
        total_amount_clp: 54_990,
        cuotas_totales: 6,
        merchant: "MP    *MERCADO LIBRE",
      },
    ]);
    expect(rows).toHaveLength(1);
  });
});
