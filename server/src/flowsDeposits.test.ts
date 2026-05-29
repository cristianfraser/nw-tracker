import { describe, expect, it } from "vitest";
import { buildFlowsDepositsPayload, flowsDepositsNetTotalByAccount } from "./flowsDeposits.js";

describe("buildFlowsDepositsPayload", () => {
  it("net_total_clp matches sum of row amounts", () => {
    const payload = buildFlowsDepositsPayload();
    const rowSum = payload.rows.reduce((s, r) => s + r.amount_clp, 0);
    expect(payload.net_total_clp).toBe(rowSum);
  });

  it("by_category totals match filtered rows", () => {
    const payload = buildFlowsDepositsPayload();
    for (const cat of Object.keys(payload.by_category) as (keyof typeof payload.by_category)[]) {
      const block = payload.by_category[cat];
      const sum = block.rows.reduce((s, r) => s + r.amount_clp, 0);
      expect(block.total_clp).toBe(sum);
    }
  });
});

describe("flowsDepositsNetTotalByAccount", () => {
  it("sums match payload rows per account", () => {
    const payload = buildFlowsDepositsPayload();
    const byAccount = flowsDepositsNetTotalByAccount();
    const fromRows = new Map<number, number>();
    for (const r of payload.rows) {
      fromRows.set(r.account_id, (fromRows.get(r.account_id) ?? 0) + r.amount_clp);
    }
    for (const [id, total] of fromRows) {
      expect(byAccount.get(id)).toBe(total);
    }
  });
});
