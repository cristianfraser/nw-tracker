import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { DEPOSITS_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { buildDepositsReconciliationPayload } from "./flowsDepositsReconciliation.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

/**
 * Task: a checking outflow the user manually categorized as `deposits` asserts that a matching
 * deposit exists. Under relaxed constraints (same rounded amount, wider date window, asserted
 * lines only) a UNIQUE candidate deposit auto-links; an ambiguous or missing candidate is
 * surfaced as `asserted_unmatched` in the reconciliation payload — never guessed.
 */

const FIXTURE_NOTE = "vitest:manual-deposit-assertion";

let checkingId: number;
let fundId: number;
let depositsCategoryId: number;

const fixtureKeys: string[] = [];

function cartolaNoteFor(occurredOn: string, amountClp: number, description: string, idx: number): string {
  const month = occurredOn.slice(0, 7);
  return (
    `import:cartola|${month}|Agustinas|${description}` +
    `|on:${occurredOn}|amt:${amountClp}|idx:${idx}`
  );
}

/** Insert a checking cartola withdrawal and manually mark it `deposits` (Único). */
function insertAssertedWithdrawal(
  occurredOn: string,
  amountClp: number,
  description: string,
  idx: number
): { movementId: number; purchaseKey: string } {
  const note = cartolaNoteFor(occurredOn, amountClp, description, idx);
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(checkingId, amountClp, occurredOn, note);
  const purchaseKey = checkingCartolaStablePurchaseKey(checkingId, note, "gastos");
  if (!purchaseKey) throw new Error("fixture purchase key not derivable");
  db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  ).run(checkingId, purchaseKey, depositsCategoryId);
  fixtureKeys.push(purchaseKey);
  return { movementId: Number(ins.lastInsertRowid), purchaseKey };
}

function insertCartolaWithdrawal(
  occurredOn: string,
  amountClp: number,
  description: string,
  idx: number
): number {
  const note = cartolaNoteFor(occurredOn, amountClp, description, idx);
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(checkingId, amountClp, occurredOn, note);
  const purchaseKey = checkingCartolaStablePurchaseKey(checkingId, note, "gastos");
  if (purchaseKey) fixtureKeys.push(purchaseKey);
  return Number(ins.lastInsertRowid);
}

function insertFundDeposit(occurredOn: string, amountClp: number): number {
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(fundId, amountClp, occurredOn, FIXTURE_NOTE);
  return Number(ins.lastInsertRowid);
}

describe("manual deposits-category assertions", () => {
  beforeAll(() => {
    checkingId = checkingAccountId();
    const fund = db.prepare(`SELECT id FROM accounts WHERE notes = 'demo:fondo'`).get() as
      | { id: number }
      | undefined;
    if (!fund) throw new Error("expected demo:fondo account in test DB");
    fundId = fund.id;
    const cat = db
      .prepare(`SELECT id FROM cc_expense_categories WHERE slug = ?`)
      .get(DEPOSITS_CC_EXPENSE_SLUG) as { id: number } | undefined;
    if (!cat) throw new Error("expected deposits cc_expense_category");
    depositsCategoryId = cat.id;
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM movements WHERE note LIKE 'import:cartola|%|idx:997400_'`).run();
    for (const key of fixtureKeys) {
      db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE purchase_key = ?`).run(key);
      db.prepare(`DELETE FROM expense_deposit_links WHERE purchase_key = ?`).run(key);
    }
    fixtureKeys.length = 0;
    // Re-sync so no auto link points at deleted movements.
    buildFlowsCreditCardExpensesPayload();
  });

  it("auto-links a manually-asserted outflow when a unique candidate deposit exists", () => {
    // 7-day gap + generic description: outside the auto-matcher's 3-day window, so only the
    // manual `deposits` assertion can pair them.
    const depositId = insertFundDeposit("2099-07-10", 2_345_678);
    const { purchaseKey } = insertAssertedWithdrawal(
      "2099-07-03",
      -2_345_678,
      "COMPRA WEB INVERSIONES XYZ SPA",
      9974001
    );

    buildFlowsCreditCardExpensesPayload();

    const link = db
      .prepare(
        `SELECT deposit_movement_id, link_source FROM expense_deposit_links WHERE purchase_key = ?`
      )
      .get(purchaseKey) as { deposit_movement_id: number; link_source: string } | undefined;
    expect(link?.deposit_movement_id).toBe(depositId);
    expect(link?.link_source).toBe("auto");

    const payload = buildDepositsReconciliationPayload();
    const depositRow = payload.rows.find((r) => r.movement_id === depositId);
    expect(depositRow?.status).toBe("linked");

    const assertion = payload.manual_assertions.find((a) => a.purchase_key === purchaseKey);
    expect(assertion?.status).toBe("linked");
    expect(assertion?.deposit_movement_id).toBe(depositId);
    expect(assertion?.candidate_count).toBe(1);
  });

  it("surfaces an ambiguous assertion (two candidate deposits) without guessing", () => {
    const depositA = insertFundDeposit("2099-08-05", 3_111_222);
    const depositB = insertFundDeposit("2099-08-08", 3_111_222);
    const { purchaseKey } = insertAssertedWithdrawal(
      "2099-08-01",
      -3_111_222,
      "COMPRA WEB INVERSIONES XYZ SPA",
      9974002
    );

    buildFlowsCreditCardExpensesPayload();

    const link = db
      .prepare(`SELECT 1 FROM expense_deposit_links WHERE purchase_key = ?`)
      .get(purchaseKey);
    expect(link).toBeUndefined();

    const payload = buildDepositsReconciliationPayload();
    const assertion = payload.manual_assertions.find((a) => a.purchase_key === purchaseKey);
    expect(assertion?.status).toBe("asserted_unmatched");
    expect(assertion?.candidate_count).toBe(2);
    expect(assertion?.deposit_movement_id).toBeNull();

    for (const movementId of [depositA, depositB]) {
      const row = payload.rows.find((r) => r.movement_id === movementId);
      expect(row?.status).toMatch(/^unlinked_/);
    }
  });

  it("surfaces an assertion with no candidate as asserted_unmatched (count 0)", () => {
    const { purchaseKey } = insertAssertedWithdrawal(
      "2099-09-02",
      -4_222_333,
      "COMPRA WEB INVERSIONES XYZ SPA",
      9974003
    );

    buildFlowsCreditCardExpensesPayload();

    const payload = buildDepositsReconciliationPayload();
    const assertion = payload.manual_assertions.find((a) => a.purchase_key === purchaseKey);
    expect(assertion?.status).toBe("asserted_unmatched");
    expect(assertion?.candidate_count).toBe(0);
  });

  it("never steals a deposit the matcher already paired with its real outflow", () => {
    // Real pairing: Fintual wire matches the fund deposit exactly (same amount, 1-day gap).
    const depositId = insertFundDeposit("2099-10-06", 5_333_444);
    insertCartolaWithdrawal("2099-10-05", -5_333_444, "0768106274 Transf a Fintual", 9974004);
    // Asserted outflow with the same amount a few days later: its only candidate is already taken.
    const { purchaseKey } = insertAssertedWithdrawal(
      "2099-10-08",
      -5_333_444,
      "COMPRA WEB INVERSIONES XYZ SPA",
      9974005
    );

    buildFlowsCreditCardExpensesPayload();

    const payload = buildDepositsReconciliationPayload();
    const depositRow = payload.rows.find((r) => r.movement_id === depositId);
    expect(depositRow?.status).toBe("linked");

    const assertion = payload.manual_assertions.find((a) => a.purchase_key === purchaseKey);
    expect(assertion?.status).toBe("asserted_unmatched");
    expect(assertion?.candidate_count).toBe(0);
    const link = db
      .prepare(`SELECT 1 FROM expense_deposit_links WHERE purchase_key = ?`)
      .get(purchaseKey);
    expect(link).toBeUndefined();
  });
});
