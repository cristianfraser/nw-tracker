import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { updateAccountExcludeFromGroupTotals } from "./accountExcludeFromGroupTotals.js";
import { clearAccountCategoryMetaCache } from "./liabilitiesValuation.js";

describe("updateAccountExcludeFromGroupTotals", () => {
  it("toggles the flag on a CC master and restores it", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const prev = db
      .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
      .get(master.id) as { exclude_from_group_totals: number };

    try {
      const updated = updateAccountExcludeFromGroupTotals(master.id, true);
      expect(updated).toEqual({ exclude_from_group_totals: 1 });
      const row = db
        .prepare(`SELECT exclude_from_group_totals FROM accounts WHERE id = ?`)
        .get(master.id) as { exclude_from_group_totals: number };
      expect(row.exclude_from_group_totals).toBe(1);
    } finally {
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(
        prev.exclude_from_group_totals,
        master.id
      );
      clearAccountCategoryMetaCache();
    }
  });

  it("returns null for missing account or invalid body", () => {
    expect(updateAccountExcludeFromGroupTotals(999_999_999, true)).toBeNull();
    expect(updateAccountExcludeFromGroupTotals(1, "yes")).toBeNull();
  });
});
