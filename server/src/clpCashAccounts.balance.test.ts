import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clpCashBalanceClpAt, isClpCashAccount } from "./clpCashAccounts.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";

describe("CLP cash account (ledger / flows-based)", () => {
  it("derives its balance from movement/transfer legs, not valuation snapshots", async () => {
    // The Vitest person's broker peso balance (`generate.ts` «Broker CLP»).
    const row = db
      .prepare(`SELECT id AS account_id FROM accounts WHERE import_key = 'import:panel|kind=clp|key=broker_clp'`)
      .get() as { account_id: number } | undefined;
    expect(row).toBeDefined();
    const accountId = row!.account_id;

    expect(isClpCashAccount(accountId)).toBe(true);

    // No valuation snapshots for a flows-based cash account.
    const valCount = db
      .prepare(`SELECT COUNT(*) AS n FROM valuations WHERE account_id = ?`)
      .get(accountId) as { n: number };
    expect(valCount.n).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const before = clpCashBalanceClpAt(accountId, today);

    // A movement of its own moves the ledger by exactly its pesos.
    const movementId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
           VALUES (?, 12345, 'clp', ?, 'vitest:clp-cash-balance|fixture')`
        )
        .run(accountId, tenDaysAgo).lastInsertRowid
    );
    try {
      const ledger = clpCashBalanceClpAt(accountId, today);
      expect(ledger).toBe(before + 12345);

      const dashRows = await buildDashboardAccountRows("clp");
      const dash = dashRows.find((r) => r.account_id === accountId);
      expect(dash).toBeDefined();
      // Dashboard balance matches the ledger sum (not the missing valuation → 0).
      expect(dash!.current_value).toBe(ledger);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});
