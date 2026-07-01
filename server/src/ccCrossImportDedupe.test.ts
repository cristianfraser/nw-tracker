import { describe, expect, it } from "vitest";
import {
  installmentPurchaseMatchesOneShot,
  merchantsMatchForCrossDedupe,
  purchaseAmountsMatch,
} from "./ccCrossImportDedupe.js";

describe("ccCrossImportDedupe", () => {
  it("matches merchant stems across paste and manual labels", () => {
    expect(
      merchantsMatchForCrossDedupe("MERCADOPAGO*MIBICIO", "MERCADOPAGO*MIBICIO")
    ).toBe(true);
    expect(
      merchantsMatchForCrossDedupe(
        "MERCADOPAGO*MIBICIO",
        "MERCADOPAGO*MIBICIO 12 CUOTAS"
      )
    ).toBe(true);
    expect(
      merchantsMatchForCrossDedupe("EXPRESS PLAZA L", "RECAUDACION EX PLAZA LYON")
    ).toBe(true);
  });

  it("matches purchase total to one-shot line amount within tolerance", () => {
    expect(purchaseAmountsMatch(492_000, 492_000)).toBe(true);
    expect(purchaseAmountsMatch(492_000, 491_500)).toBe(true);
    expect(purchaseAmountsMatch(492_000, 480_000)).toBe(false);
  });

  it("requires same purchase date and principal for overlap", () => {
    const purchase = {
      id: 1,
      purchase_date: "2026-05-19",
      total_amount_clp: 492_000,
      cuotas_totales: 12,
      merchant: "MERCADOPAGO*MIBICIO",
    };
    expect(
      installmentPurchaseMatchesOneShot(
        purchase,
        "MERCADOPAGO*MIBICIO",
        "2026-05-19",
        492_000
      )
    ).toBe(true);
    expect(
      installmentPurchaseMatchesOneShot(
        purchase,
        "MERCADOPAGO*MIBICIO",
        "2026-05-20",
        492_000
      )
    ).toBe(false);
    expect(
      installmentPurchaseMatchesOneShot(
        purchase,
        "JUMBO COSTANERA",
        "2026-05-19",
        492_000
      )
    ).toBe(false);
  });

  it("matches a re-imported single cuota against the converted installment", () => {
    // BCI Lider website first lists a purchase as the full total (92.918, 6 cuotas), then
    // re-lists it as the per-cuota charge (92.918 / 6 ≈ 15.486). Both must dedupe.
    const purchase = {
      id: 2,
      purchase_date: "2026-06-28",
      total_amount_clp: 92_918,
      cuotas_totales: 6,
      merchant: "TGR",
    };
    expect(
      installmentPurchaseMatchesOneShot(purchase, "TGR", "2026-06-28", 92_918)
    ).toBe(true);
    expect(
      installmentPurchaseMatchesOneShot(purchase, "TGR", "2026-06-28", 15_486)
    ).toBe(true);
    // Unrelated amount at the same merchant/date is still a distinct purchase.
    expect(
      installmentPurchaseMatchesOneShot(purchase, "TGR", "2026-06-28", 30_000)
    ).toBe(false);
  });
});
