import { describe, expect, it } from "vitest";
import { db } from "../db.js";
import { cardLifecycle, cardNavRetired, cardStoppedBilling, cardSuperseded } from "./lifecycle.js";

function fixtureMasterId(): number | null {
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

describe("card lifecycle", () => {
  it("ranks superseded over retired over billing state", () => {
    const id = fixtureMasterId();
    if (!id) return;
    const before = db
      .prepare(`SELECT nav_retired, superseded_target_last4 FROM credit_card_account_config WHERE account_id = ?`)
      .get(id) as { nav_retired: number; superseded_target_last4: string | null };
    const set = db.prepare(`UPDATE credit_card_account_config SET nav_retired = ?, superseded_target_last4 = ? WHERE account_id = ?`);
    try {
      set.run(0, null, id);
      expect(cardLifecycle(id)).toBe(cardStoppedBilling(id) ? "billing_stopped" : "active");
      set.run(1, null, id);
      expect(cardNavRetired(id)).toBe(true);
      expect(cardLifecycle(id)).toBe("retired");
      set.run(1, "9999", id);
      expect(cardSuperseded(id)).toBe(true);
      expect(cardLifecycle(id)).toBe("superseded");
    } finally {
      set.run(before.nav_retired, before.superseded_target_last4, id);
    }
  });
});
