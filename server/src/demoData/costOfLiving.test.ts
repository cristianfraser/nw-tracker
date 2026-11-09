import { describe, expect, it } from "vitest";
import { AUSTIN, SANTIAGO, drawnBasketTotal, drawnRows, santiagoBasketPerUnit } from "./costOfLiving.js";

describe("demo cost of living", () => {
  it("Santiago's drawn rows are the story's category shares, bit for bit and in draw order", () => {
    const legacy: [string, number][] = [
      ["supermarket", 0.27],
      ["food", 0.19],
      ["fun", 0.13],
      ["transportation", 0.07],
      ["clothes", 0.08],
      ["others", 0.11],
      ["hobbies", 0.06],
      ["healthcare", 0.06],
      ["subscriptions", 0.03],
    ];
    expect(drawnRows(SANTIAGO).map((r) => [r.row.slug, r.perLevel])).toEqual(legacy);
    expect(drawnBasketTotal(SANTIAGO)).toBe(525_000);
    expect(santiagoBasketPerUnit(SANTIAGO)).toBe(1);
  });

  it("every Austin row is paid somewhere and its bills add up to the row", () => {
    for (const r of Object.values(AUSTIN.rows)) {
      if (r!.paidAs === "drawn") expect(r!.pool && r!.pay).toBeTruthy();
      if (r!.paidAs === "bills") expect(r!.bills!.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 12);
    }
    expect(AUSTIN.rows.groceries!.pay).toBe("debit");
    // A dollar buys a few hundred real pesos of Santiago's basket (the ratchet's exchange rate).
    expect(santiagoBasketPerUnit(AUSTIN)).toBeGreaterThan(300);
    expect(santiagoBasketPerUnit(AUSTIN)).toBeLessThan(500);
  });
});
