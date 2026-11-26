import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";

let accountId = 0;

beforeAll(() => {
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  accountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, 'vitest goal units sign', 'vitest:goal-units-sign')`)
      .run(group.id).lastInsertRowid
  );
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, 'vitest goal units', ?)`
  );
  ins.run(accountId, 1000, "2025-01-10", 10);
  ins.run(accountId, -1000, "2025-02-10", -10);
  ins.run(accountId, -500, "2025-03-10", -5);
});

afterAll(() => {
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
});

describe("fintualGoalUnitsFromMovementsThroughDate", () => {
  it("a goal holding cuotas reads them; one withdrawn to exactly zero reads as emptied (null)", () => {
    expect(fintualGoalUnitsFromMovementsThroughDate(accountId, "2025-01-31")).toBe(10);
    expect(fintualGoalUnitsFromMovementsThroughDate(accountId, "2025-02-28")).toBeNull();
  });

  it("a negative sum throws, naming the account and the sum", () => {
    expect(() => fintualGoalUnitsFromMovementsThroughDate(accountId, "2025-03-31")).toThrow(
      new RegExp(`account ${accountId} sum to -5 through 2025-03-31`)
    );
    expect(() => fintualGoalUnitsFromMovementsThroughDate(accountId)).toThrow(/sum to -5/);
  });

  it("a malformed as-of date throws instead of meaning today", () => {
    expect(() => fintualGoalUnitsFromMovementsThroughDate(accountId, "31/01/2025")).toThrow(/not YYYY-MM-DD/);
  });
});
