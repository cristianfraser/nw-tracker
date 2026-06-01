import { describe, expect, it } from "vitest";
import { checkingCartolaStablePurchaseKey, movementNote } from "./checkingCartolaParse.js";
import {
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import {
  backfillCheckingAutoMatchCategories,
  movementForCheckingPurchaseKey,
  resolveAutoMatchCategoryIdForCheckingPurchase,
} from "./backfillCheckingAutoMatchCategories.js";

describe("backfillCheckingAutoMatchCategories", () => {
  it("reclassifies checking unique purchases without deleting rows", () => {
    const depositsCat = getCcExpenseCategoryBySlug(DEPOSITS_CC_EXPENSE_SLUG);
    const checkingCat = getCcExpenseCategoryBySlug(CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG);
    if (!depositsCat || !checkingCat) return;

    const corrienteId = (
      db
        .prepare(
          `SELECT a.id FROM accounts a
           JOIN asset_groups g ON g.id = a.asset_group_id
           WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`
        )
        .get() as { id: number } | undefined
    )?.id;
    if (corrienteId == null) return;

    const note = movementNote("2099-11", "Agustinas", "Transf. Internet a otro Bancos", "", {
      occurredOn: "2099-11-05",
      amountClp: -50_000,
      cartolaIndex: 9990042,
    });
    const ins = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(corrienteId, -50_000, "2099-11-05", note);
    const movementId = Number(ins.lastInsertRowid);
    const purchaseKey = checkingCartolaStablePurchaseKey(corrienteId, note)!;

    const vistaId = (
      db
        .prepare(
          `SELECT a.id FROM accounts a
           JOIN asset_groups g ON g.id = a.asset_group_id
           WHERE g.slug LIKE '%cuenta_vista%' LIMIT 1`
        )
        .get() as { id: number } | undefined
    )?.id;
    if (vistaId == null) return;

    const vistaNote = movementNote("2099-11", "Agustinas", "Transf. Internet a otro Bancos", "", {
      occurredOn: "2099-11-05",
      amountClp: 50_000,
      cartolaIndex: 9990043,
    });
    const vistaIns = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(vistaId, 50_000, "2099-11-05", vistaNote);
    const vistaMovementId = Number(vistaIns.lastInsertRowid);

    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(
      corrienteId,
      purchaseKey
    );
    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)`
    ).run(corrienteId, purchaseKey, depositsCat.id);

    const movement = movementForCheckingPurchaseKey(corrienteId, purchaseKey);
    expect(movement?.id).toBe(movementId);

    const nextId = resolveAutoMatchCategoryIdForCheckingPurchase(
      corrienteId,
      purchaseKey,
      movement!
    );
    expect(nextId).toBe(checkingCat.id);

    const result = backfillCheckingAutoMatchCategories();
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(corrienteId, purchaseKey) as { category_id: number | null };
    expect(row.category_id).toBe(checkingCat.id);

    db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(movementId, vistaMovementId);
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(
      corrienteId,
      purchaseKey
    );
  });
});
