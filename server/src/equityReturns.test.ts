import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { equityReturnSnapshot } from "./equityReturns.js";

/** Synthetic equity MTM account (one unit-bearing buy), removed after the suite. */
let accountId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;
  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · equity returns', 'vitest-equity-returns', 'vitest-equity-returns', 'VITESTRET.SN')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 100000, 'clp', '2026-03-10', 'vitest-equity-returns-buy', 'stock_buy', 10)`
  ).run(accountId);
});

afterAll(() => {
  if (accountId == null) return;
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
});

describe("equityReturnSnapshot — return on deposited", () => {
  it("is the total return over the capital deposited", () => {
    if (accountId == null) return;
    const snap = equityReturnSnapshot(accountId, 100_000, 110_000)!;
    expect(snap.total_return_clp).toBe(10_000);
    expect(snap.return_on_deposited_pct).toBeCloseTo(0.1, 12);
  });

  it("a position sold off has no capital base left: null, not −100%", () => {
    if (accountId == null) return;
    // Sold everything at a loss: 2.000 of net deposits remain against a value of 0.
    const snap = equityReturnSnapshot(accountId, 2_000, 0)!;
    expect(snap.total_return_clp).toBe(-2_000);
    expect(snap.return_on_deposited_pct).toBeNull();
  });
});
