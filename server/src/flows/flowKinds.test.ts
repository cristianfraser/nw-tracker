import { describe, expect, it } from "vitest";
import { db } from "../db.js";

describe("flow kinds of new rows", () => {
  it("a manual expense is a purchase flow, not a card purchase (migration 288)", () => {
    const id = Number(
      db
        .prepare(`INSERT INTO expense_entries (amount, spent_on, note, merchant) VALUES (1000, '2031-01-15', 'manual: vitest', 'VITEST SHOP')`)
        .run().lastInsertRowid
    );
    try {
      const row = db
        .prepare(`SELECT f.kind FROM expense_entries e JOIN flows f ON f.id = e.flow_id WHERE e.id = ?`)
        .get(id) as { kind: string } | undefined;
      expect(row?.kind).toBe("purchase");
    } finally {
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(id);
    }
  });
});
