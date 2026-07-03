import { describe, expect, it } from "vitest";
import { compareFlowRowsForDisplay, intraDayFlowRank } from "./brokerageFlowMovement.js";

type Row = { id: number; occurred_on: string; flow_kind: string | null };

function sorted(rows: Row[]): number[] {
  return [...rows].sort(compareFlowRowsForDisplay).map((r) => r.id);
}

describe("intraDayFlowRank", () => {
  it("orders the cash pipeline: inflows < transfers < sell < fx < buy < withdrawal", () => {
    const ranks = [
      "deposit_clp",
      null,
      "stock_sell",
      "compra_usd_venta_clp",
      "stock_buy",
      "withdrawal_clp",
    ].map(intraDayFlowRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("compareFlowRowsForDisplay", () => {
  it("renders a same-day funding chain newest-first regardless of entry order", () => {
    // Entered out of order: fx and buys first (low ids), funding transfers last.
    const rows: Row[] = [
      { id: 11106, occurred_on: "2026-07-01", flow_kind: "compra_usd_venta_clp" },
      { id: 11109, occurred_on: "2026-07-01", flow_kind: "stock_buy" },
      { id: 11113, occurred_on: "2026-07-01", flow_kind: null },
      { id: 11112, occurred_on: "2026-07-01", flow_kind: null },
    ];
    // Top-to-bottom: buy, fx, plain transfers (funding, entry order via id).
    expect(sorted(rows)).toEqual([11109, 11106, 11113, 11112]);
  });

  it("sorts by date before intra-day rank", () => {
    const rows: Row[] = [
      { id: 1, occurred_on: "2026-07-02", flow_kind: "deposit_clp" },
      { id: 2, occurred_on: "2026-07-01", flow_kind: "stock_buy" },
    ];
    expect(sorted(rows)).toEqual([1, 2]);
  });

  it("keeps id DESC as the tie-break within a rank", () => {
    const rows: Row[] = [
      { id: 5, occurred_on: "2026-07-01", flow_kind: "stock_buy" },
      { id: 9, occurred_on: "2026-07-01", flow_kind: "stock_buy" },
    ];
    expect(sorted(rows)).toEqual([9, 5]);
  });
});
