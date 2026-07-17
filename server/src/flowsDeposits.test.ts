import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFlowsDepositsPayload, flowsDepositsNetTotalByAccount } from "./flowsDeposits.js";
import { db } from "./db.js";

describe("buildFlowsDepositsPayload", () => {
  it("net_total_clp matches sum of row amounts", () => {
    const payload = buildFlowsDepositsPayload();
    const rowSum = payload.rows.reduce((s, r) => s + r.amount_clp, 0);
    expect(payload.net_total_clp).toBe(rowSum);
    if (payload.fx_conversion_error) {
      expect(payload.net_total_usd).toBeNull();
    } else if (payload.rows.some((r) => r.amount_usd != null)) {
      expect(payload.net_total_usd).not.toBeNull();
    }
    expect(Array.isArray(payload.fx_conversion_warnings)).toBe(true);
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

describe("state contributions are P/L, not deposits", () => {
  let accountId: number | null = null;

  beforeAll(() => {
    const group = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_cash__clp'`)
      .get() as { id: number } | undefined;
    if (!group) return;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, account_kind) VALUES (?, ?, 'master')`)
        .run(group.id, "vitest-flows-deposits-state-bonus").lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind)
       VALUES (?, ?, ?, ?, ?)`
    );
    ins.run(accountId, 100_000, "2024-05-10", "vitest personal deposit", null);
    ins.run(accountId, 50_000, "2024-05-20", "vitest state bonus", "aporte_estatal_clp");
  });

  afterAll(() => {
    if (accountId == null) return;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("excludes aporte_estatal_clp from deposit rows and per-account totals", () => {
    if (accountId == null) return;
    const payload = buildFlowsDepositsPayload();
    const rows = payload.rows.filter((r) => r.account_id === accountId);
    expect(rows.map((r) => r.amount_clp)).toEqual([100_000]);
    expect(flowsDepositsNetTotalByAccount().get(accountId)).toBe(100_000);
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
