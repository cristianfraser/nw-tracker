import { describe, expect, it } from "vitest";
import {
  checkingCartolaStablePurchaseKey,
  movementNote,
} from "./checkingCartolaParse.js";
import {
  legacyCheckingGastosPurchaseKey,
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
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key LIKE ?`).run(
      accountId,
      "checking-cartola:%2099-05%"
    );
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key LIKE ?`).run(
      accountId,
      "checking-mv:%"
    );

    const ins = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(accountId, -50_000, "2099-05-10", note);
    const oldId = Number(ins.lastInsertRowid);

    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)`
    ).run(accountId, legacyCheckingGastosPurchaseKey(oldId), fun.id);

    preserveCheckingGastosCategoriesForCartolaNotes(accountId, prefix);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(oldId);

    const ins2 = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(accountId, -50_000, "2099-05-10", note);
    const newId = Number(ins2.lastInsertRowid);

    expect(checkingGastosMovementPurchaseKey(newId)).toBe(
      checkingCartolaStablePurchaseKey(accountId, note)
    );
    const stableKey = checkingCartolaStablePurchaseKey(accountId, note)!;
    const row = db
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, stableKey) as { category_id: number } | undefined;
    expect(row?.category_id).toBe(fun.id);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      prefix
    );
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE purchase_key = ?`).run(
      stableKey
    );
  });

  it("migrateCheckingGastosCategoryToStableKey copies legacy row", () => {
    const accountId = testCheckingAccountId();
    const bills = getCcExpenseCategoryBySlug("bills");
    if (accountId == null || !bills) return;

    const note = movementNote("2099-06", "Agustinas", "Vitest migrate", "", {
      occurredOn: "2099-06-01",
      amountClp: -1,
      cartolaIndex: 0,
    });
    const ins = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(accountId, -1, "2099-06-01", note);
    const id = Number(ins.lastInsertRowid);
    const legacy = legacyCheckingGastosPurchaseKey(id);
    const stable = checkingCartolaStablePurchaseKey(accountId, note)!;
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key IN (?, ?)`).run(
      accountId,
      legacy,
      stable
    );
    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)`
    ).run(accountId, legacy, bills.id);

    migrateCheckingGastosCategoryToStableKey(accountId, id, note);

    const row = db
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, stable) as { category_id: number } | undefined;
    expect(row?.category_id).toBe(bills.id);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE purchase_key IN (?, ?)`).run(
      legacy,
      stable
    );
  });
});
