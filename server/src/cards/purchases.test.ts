import { describe, expect, it } from "vitest";
import {
  dedupeInstallmentPurchaseLedgerRows,
  merchantsMatchForCrossDedupe,
  planMatchesOneShotLine,
  purchaseFirstDueYm,
  type CardPlanForMatching,
} from "./purchases.js";

const plan = (over: Partial<CardPlanForMatching> = {}): CardPlanForMatching => ({
  id: 1,
  purchase_date: "2026-06-30",
  total_amount_clp: 300_000,
  cuotas_totales: 3,
  merchant: "TIENDA EJEMPLO",
  twin_index: 0,
  ...over,
});

describe("purchases: a line that has a plan", () => {
  it("is the plan's purchase at its principal or one cuota, same merchant and day", () => {
    expect(planMatchesOneShotLine(plan(), "TIENDA EJEMPLO", "2026-06-30", 300_000)).toBe(true);
    expect(planMatchesOneShotLine(plan(), "TIENDA EJEMPLO", "2026-06-30", 100_000)).toBe(true);
    expect(planMatchesOneShotLine(plan(), "TIENDA EJEMPLO", "2026-07-01", 300_000)).toBe(false);
    expect(planMatchesOneShotLine(plan(), "OTRA TIENDA", "2026-06-30", 300_000)).toBe(false);
    expect(planMatchesOneShotLine(plan(), "TIENDA EJEMPLO", "2026-06-30", 250_000)).toBe(false);
  });

  it("matches merchants across the statement and the web table (BCI suffixes)", () => {
    expect(merchantsMatchForCrossDedupe("ENTEL HOGAR (T)", "ENTEL HOGAR,SANTIAGO")).toBe(true);
    expect(merchantsMatchForCrossDedupe("ENTEL HOGAR", "OTRO")).toBe(false);
  });

  it("keeps one plan per identity: a contract-summary row gives way", () => {
    const rows = dedupeInstallmentPurchaseLedgerRows([
      plan({ id: 5, merchant: "03 CUOTAS COMERC" }),
      plan({ id: 2, merchant: "03 CUOTAS COMERC" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([5]);
  });
});

describe("purchases: a plan's first cuota month", () => {
  const pr = { id: 9, purchase_date: "2026-03-15", merchant: "TIENDA", source: "pdf", first_due_month: null };
  const pay = (over: Partial<Parameters<typeof purchaseFirstDueYm>[1][number]>) => ({
    pay_by_date: "2026-05-10",
    statement_date: null,
    statement_period_month: null,
    period_to_join: null,
    amount_clp: 10_000,
    cuota_current: null,
    ...over,
  });

  it("is the month of the printed cuota 1", () => {
    expect(purchaseFirstDueYm(pr, [pay({ cuota_current: 1, statement_period_month: "2026-04" })])).toBe("2026-04");
  });

  it("is the statement after the last 00/N preamble", () => {
    expect(purchaseFirstDueYm(pr, [pay({ cuota_current: 0, statement_period_month: "2026-03" })])).toBe("2026-04");
  });

  it("falls to the purchase month, and throws naming the plan when it cannot read one", () => {
    expect(purchaseFirstDueYm(pr, [])).toBe("2026-03");
    expect(() => purchaseFirstDueYm({ ...pr, purchase_date: "??" }, [])).toThrow(/Plan 9 \(TIENDA\)/);
  });
});
