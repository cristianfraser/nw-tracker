import { describe, expect, it } from "vitest";
import { getGroupValuationTimeseries } from "./valuationTimeseries.js";

/**
 * Regression: the credit-card group "Total" line (`__group_val_total`) must equal the sum of the
 * per-card valuation lines at every point.
 *
 * Prior bug: the consolidated total was built via `accountMarkClpAtYmd`, whose credit-card branch was
 * gated on `categorySlug === "credit_card"` (exact string). Real bucket slugs are `credit_cards__credit_card`,
 * so the guard was false and the total fell back to (possibly stale) stored `valuations` instead of the live
 * billing ledger — while the per-card lines used the live ledger. Result: Total ≠ Σ(cards) after a payment
 * that changed the ledger without a re-import of that account.
 */
describe("CC group total matches sum of per-card lines", () => {
  it("__group_val_total equals the sum of per-account data lines at every point", () => {
    const ts = getGroupValuationTimeseries("liabilities_credit_card", "clp");
    const accs = ts.accounts_in_group.accounts;
    const total = accs.find((a) => a.dataKey === "__group_val_total");
    if (!total) return; // fewer than 2 cards → no synthetic Total line
    const cardKeys = accs
      .filter((a) => a.dataKey !== "__group_val_total" && a.valueSeriesType === "data")
      .map((a) => a.dataKey);
    if (cardKeys.length === 0) return;

    const mismatches: { as_of_date: string; total: number; sumCards: number; diff: number }[] = [];
    for (const p of ts.accounts_in_group.points) {
      const t = p["__group_val_total"];
      if (typeof t !== "number" || !Number.isFinite(t)) continue;
      let sum = 0;
      for (const k of cardKeys) {
        const v = p[k];
        if (typeof v === "number" && Number.isFinite(v)) sum += v;
      }
      const diff = Math.abs(t - sum);
      if (diff > 1) {
        mismatches.push({ as_of_date: String(p.as_of_date), total: t, sumCards: sum, diff });
      }
    }

    expect(
      mismatches,
      `credit-card group Total diverges from Σ per-card lines: ${JSON.stringify(mismatches.slice(0, 8))}`
    ).toHaveLength(0);
  });
});
