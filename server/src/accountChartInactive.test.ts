import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountChartInactive } from "./accountChartInactive.js";

describe("accountChartInactive", () => {
  it("never hides credit cards registered under credit_card_group_items", () => {
    const row = db
      .prepare(
        `SELECT i.account_id AS id
         FROM credit_card_group_items i
         JOIN credit_card_groups g ON g.id = i.group_id
         WHERE g.slug = 'santander' AND i.item_kind = 'account'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(accountChartInactive(row.id)).toBe(false);
  });
});
