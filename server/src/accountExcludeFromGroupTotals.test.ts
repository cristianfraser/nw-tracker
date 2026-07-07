import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { updateAccountExcludeFromGroupTotals } from "./accountExcludeFromGroupTotals.js";
import { clearAccountCategoryMetaCache } from "./liabilitiesValuation.js";

describe("updateAccountExcludeFromGroupTotals", () => {
  it("syncs CC master and liability_view when updating master", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const view = db
      .prepare(
        `SELECT id, exclude_from_group_totals FROM accounts
         WHERE source_account_id = ? AND account_kind = 'liability_view'`
      )
      .get(master.id) as { id: number; exclude_from_group_totals: number } | undefined;
    if (!view) return;

    const prevMaster = db
      .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
      .get(master.id) as { exclude_from_group_totals: number };
    const prevView = view.exclude_from_group_totals;

    try {
      const updated = updateAccountExcludeFromGroupTotals(master.id, true);
      expect(updated).toEqual({ exclude_from_group_totals: 1 });

      const masterRow = db
        .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
        .get(master.id) as { exclude_from_group_totals: number };
      const viewRow = db
        .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
        .get(view.id) as { exclude_from_group_totals: number };
      expect(masterRow.exclude_from_group_totals).toBe(1);
      expect(viewRow.exclude_from_group_totals).toBe(1);
    } finally {
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(
        prevMaster.exclude_from_group_totals,
        master.id
      );
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(
        prevView,
        view.id
      );
      clearAccountCategoryMetaCache();
    }
  });

  it("returns null for missing account or invalid body", () => {
    expect(updateAccountExcludeFromGroupTotals(999_999_999, true)).toBeNull();
    expect(updateAccountExcludeFromGroupTotals(1, "yes")).toBeNull();
  });
});
