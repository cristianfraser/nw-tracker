import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFlowsDepositsPayload,
  flowsDepositsNetTotalByAccount,
  netDepositFlowBetween,
} from "./flowsDeposits.js";
import {
  totalDisplayDepositsClpForAccount,
  totalWithdrawalsClpForAccount,
} from "./accountDeposits.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
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
        .prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`)
        .run(group.id, "vitest-flows-deposits-state-bonus").lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
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

describe("forward-posted movements count today and move to their bank date when it arrives", () => {
  let accountId: number | null = null;

  beforeAll(() => {
    const group = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_cash__clp'`)
      .get() as { id: number } | undefined;
    if (!group) return;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`)
        .run(group.id, "vitest-flows-deposits-future-dated").lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    ins.run(accountId, 100_000, "2024-05-10", "vitest past deposit", null);
    // Bank-scheduled giro imported from a partial cartola before its value date.
    ins.run(accountId, -130_000, chileCalendarAddDays(chileCalendarTodayYmd(), 2), "vitest future giro", null);
  });

  afterAll(() => {
    if (accountId == null) return;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("includes the forward-posted giro in totals and lists it under today with its bank date", () => {
    if (accountId == null) return;
    const today = chileCalendarTodayYmd();
    const postedOn = chileCalendarAddDays(today, 2);
    // As-of-now like the balance (`displayLedgerCutoffYmd`): the giro is already money out.
    expect(flowsDepositsNetTotalByAccount().get(accountId)).toBe(-30_000);
    expect(totalDisplayDepositsClpForAccount(accountId)).toBe(-30_000);
    expect(totalWithdrawalsClpForAccount(accountId)).toBe(130_000);
    const rows = buildFlowsDepositsPayload()
      .rows.filter((r) => r.account_id === accountId)
      .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    expect(rows.map((r) => [r.occurred_on, r.amount_clp, r.posted_on ?? null])).toEqual([
      ["2024-05-10", 100_000, null],
      [today, -130_000, postedOn],
    ]);
    // Window legs: today's bucket carries it, a window that ends yesterday does not.
    expect(netDepositFlowBetween(accountId, chileCalendarAddDays(today, -1), today, "clp")).toBe(-130_000);
    expect(
      netDepositFlowBetween(accountId, chileCalendarAddDays(today, -3), chileCalendarAddDays(today, -1), "clp")
    ).toBe(0);
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
