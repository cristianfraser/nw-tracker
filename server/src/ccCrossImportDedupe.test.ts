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
});
