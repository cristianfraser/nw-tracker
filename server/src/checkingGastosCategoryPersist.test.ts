import { FLOW_CATEGORY_ROWS_SQL, uniqueCategoryInsert } from "./test/flowFixtures.js";
import { describe, expect, it } from "vitest";
import {
  checkingCartolaStablePurchaseKey,
  movementNote,
} from "./checkingCartolaParse.js";
import {
  checkingMovementPurchaseKey,
  migrateCheckingGastosCategoryToStableKey,
  preserveCheckingGastosCategoriesForCartolaNotes,
} from "./checkingGastosCategoryPersist.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import { db } from "./db.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";

function testCheckingAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

describe("checkingGastosCategoryPersist", () => {
  it("stable purchase key is derived from cartola note tags", () => {
    const note = movementNote("2024-04", "Agustinas", "Transf. Internet a otro Bancos", "", {
      occurredOn: "2024-04-01",
      amountClp: -100_000,
      cartolaIndex: 3,
    });
    expect(checkingCartolaStablePurchaseKey(22, note)).toBe(
      "checking-cartola:22:2024-04:2024-04-01:-100000:3"
    );
  });

  it("preserves Único category across movement id change", () => {
    const accountId = testCheckingAccountId();
    const fun = getCcExpenseCategoryBySlug("fun");
    if (accountId == null || !fun) return;

    const periodMonth = "2099-05";
    const note = movementNote("2099-05", "Agustinas", "Vitest category persist", "123", {
      occurredOn: "2099-05-10",
      amountClp: -50_000,
      cartolaIndex: 0,
    });
    const prefix = `import:cartola|${periodMonth}|%`;

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      prefix
    );
    db.prepare(`DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key LIKE ?)`).run(
      accountId,
      "checking-cartola:%2099-05%"
    );
    db.prepare(`DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key LIKE ?)`).run(
      accountId,
      "checking-mv:%"
    );

    const ins = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
      )
      .run(accountId, -50_000, "2099-05-10", note);
    const oldId = Number(ins.lastInsertRowid);

    // The row answers to its cartola key; the category sits on its flow, which the key keeps when
    // the row is deleted and imported again under a new id.
    uniqueCategoryInsert.run(accountId, checkingGastosMovementPurchaseKey(oldId), fun.id);

    preserveCheckingGastosCategoriesForCartolaNotes(accountId, prefix);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(oldId);

    const ins2 = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
      )
      .run(accountId, -50_000, "2099-05-10", note);
    const newId = Number(ins2.lastInsertRowid);

    expect(checkingGastosMovementPurchaseKey(newId)).toBe(
      checkingCartolaStablePurchaseKey(accountId, note)
    );
    const stableKey = checkingCartolaStablePurchaseKey(accountId, note)!;
    const row = db
      .prepare(
        `SELECT category_id FROM ${FLOW_CATEGORY_ROWS_SQL}
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, stableKey) as { category_id: number } | undefined;
    expect(row?.category_id).toBe(fun.id);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      prefix
    );
    db.prepare(`DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE purchase_key = ?)`).run(
      stableKey
    );
  });

  it("a cartola row's movement-id key names nothing, so no legacy row can be written under it", () => {
    const accountId = testCheckingAccountId();
    const bills = getCcExpenseCategoryBySlug("bills");
    if (accountId == null || !bills) return;
    const note = movementNote("2099-06", "Agustinas", "Vitest migrate", "", {
      occurredOn: "2099-06-01",
      amountClp: -1,
      cartolaIndex: 0,
    });
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -1, 'clp', '2099-06-01', ?)`)
        .run(accountId, note).lastInsertRowid
    );
    // A flow an earlier row of the same id left keyed would answer instead (ids are reused).
    db.prepare(`DELETE FROM flows WHERE legacy_key = ?`).run(checkingMovementPurchaseKey(id));
    try {
      expect(() => uniqueCategoryInsert.run(accountId, checkingMovementPurchaseKey(id), bills.id)).toThrow(/no expense carries/);
      expect(migrateCheckingGastosCategoryToStableKey(accountId, id, note)).toBe(0);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });
});
