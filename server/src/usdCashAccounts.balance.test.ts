import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";

/**
 * Synthetic USD-cash fixture (kind slug `usd`): conversions credit the account, equity
 * buys funded from it debit it via transfer legs — each counted once, so a fully spent
 * account nets to zero. Earlier versions pinned zero-balances of the real account at
 * fixed dates and rotted whenever real rows (e.g. a backdated dividend) landed.
 */
describe("USD cash account balance (synthetic)", () => {
  it("credits compra, debits stock_buy transfer legs, nets to zero when fully spent", async () => {
    const leaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const equityLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf || !equityLeaf) return;

    const usdId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes)
           VALUES (?, 'Vitest · USD cash fixture', 'import:panel|kind=usd|key=vitest-usd-cash')`
        )
        .run(leaf.id).lastInsertRowid
    );
    const eqId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
           VALUES (?, 'Vitest · USD buy target', 'import:panel|ticker=VUSD|key=vitest-usd-eq', 'VUSD')`
        )
        .run(equityLeaf.id).lastInsertRowid
    );
    const movIds: number[] = [];
    const ins = db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, amount_usd, occurred_on, note, flow_kind, units_delta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Two conversions into USD cash (single-leg compra rows on the account).
    movIds.push(Number(ins.run(usdId, null, null, 900_000, 1_000, "2026-02-10", "vitest-compra-1", "compra_usd_venta_clp", null).lastInsertRowid));
    movIds.push(Number(ins.run(usdId, null, null, 450_000, 500, "2026-03-05", "vitest-compra-2", "compra_usd_venta_clp", null).lastInsertRowid));
    // Buys funded from USD cash: transfer legs usd -> equity.
    movIds.push(Number(ins.run(null, usdId, eqId, 0, 900, "2026-03-10", "vitest-buy-1", "stock_buy", 5).lastInsertRowid));
    movIds.push(Number(ins.run(null, usdId, eqId, 0, 600, "2026-04-02", "vitest-buy-2", "stock_buy", 3).lastInsertRowid));

    try {
      // Running balance: +1000, +500, −900, −600.
      expect(usdCashBalanceUsdAt(usdId, "2026-02-28")).toBeCloseTo(1_000, 6);
      expect(usdCashBalanceUsdAt(usdId, "2026-03-09")).toBeCloseTo(1_500, 6);
      expect(usdCashBalanceUsdAt(usdId, "2026-03-31")).toBeCloseTo(600, 6);
      expect(usdCashBalanceUsdAt(usdId, "2026-04-30")).toBeCloseTo(0, 6);

      // Dashboard rows agree with the balance function and keep the identity.
      const today = chileCalendarTodayYmd();
      const dashUsd = await buildDashboardAccountRows(true);
      const row = dashUsd.find((r) => r.account_id === usdId);
      expect(row).toBeDefined();
      if (row?.current_value_usd != null) {
        expect(row.current_value_usd).toBeCloseTo(usdCashBalanceUsdAt(usdId, today), 2);
      }
      if (row?.current_value_usd != null && row.deposits_usd != null && row.delta_total_usd != null) {
        expect(row.delta_total_usd).toBeCloseTo(row.current_value_usd - row.deposits_usd, 2);
      }
    } finally {
      for (const id of movIds) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(usdId, eqId);
    }
  });
});
