import { afterAll, describe, expect, it } from "vitest";
import {
  AUTO_ADDITIONAL_CARD_NOTE_PREFIX,
  applyAdditionalCardNoCuentaForLine,
  formatAutoAdditionalCardNote,
  isAdditionalCardExpenseLine,
  mergeAutoAdditionalCardNote,
  mergeUserDeclinedAutoCategoryNote,
  stripUserDeclinedAutoCategoryNote,
} from "./ccAdditionalCardExpenseMatch.js";
import {
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

describe("ccAdditionalCardExpenseMatch", () => {
  it("detects adicional lines only for registry-listed additional cards", () => {
    // 4999 is the fixture's additional_card_last4s entry.
    expect(isAdditionalCardExpenseLine("4999", "4242")).toBe(true);
    expect(isAdditionalCardExpenseLine("4242", "4242")).toBe(false);
    expect(isAdditionalCardExpenseLine(null, "4242")).toBe(false);
    expect(isAdditionalCardExpenseLine("4999", null)).toBe(false);
    // A foreign origin NOT in the list (own successor/predecessor plastic on a
    // transition-month statement) is the user's own purchase.
    expect(isAdditionalCardExpenseLine("4242", "4111")).toBe(false);
    expect(isAdditionalCardExpenseLine("4999", "4242", ["4999"])).toBe(true);
    expect(isAdditionalCardExpenseLine("4999", "4242", [])).toBe(false);
  });

  it("formats and merges auto additional-card notes", () => {
    const auto = formatAutoAdditionalCardNote({ originLast4: "4999", primaryLast4: "4242" });
    expect(auto).toBe(`${AUTO_ADDITIONAL_CARD_NOTE_PREFIX}|origin:4999|stmt:4242`);
    expect(mergeAutoAdditionalCardNote("", auto)).toBe(auto);
    expect(mergeAutoAdditionalCardNote("user note", auto)).toBe(`${auto}\n\nuser note`);
    expect(mergeAutoAdditionalCardNote(`${auto}\n\nkeep me`, auto)).toBe(`${auto}\n\nkeep me`);
  });

  it("merges and strips user-declined auto category marker in purchase notes", () => {
    expect(mergeUserDeclinedAutoCategoryNote("")).toBe("auto:user-declined-auto-category");
    expect(mergeUserDeclinedAutoCategoryNote("user note")).toContain("user note");
    expect(stripUserDeclinedAutoCategoryNote(mergeUserDeclinedAutoCategoryNote("user note"))).toBe(
      "user note"
    );
  });

  it("does not apply adicional no_cuenta to installment contract lines", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', 'vitest-addl-installment.pdf', '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId);
    const statementId = Number(stmt.lastInsertRowid);
    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag,
           nro_cuota_current, nro_cuota_total, parser_row_id, origin_card_last4
         ) VALUES (?, '19/05/2026', 'Adicional installment fixture', 5000, 1, 2, 6, 'vitest-addl-inst', '4999')`
      )
      .run(statementId);
    const lineId = Number(line.lastInsertRowid);

    const result = applyAdditionalCardNoCuentaForLine({
      accountId,
      statementLineId: lineId,
      originCardLast4: "4999",
      primaryCardLast4: "4242",
    });
    expect(result.skippedInstallment).toBe(true);
    expect(result.applied).toBe(false);

    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  });

  it("does not overwrite an existing unique purchase category on adicional lines", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', 'vitest-addl-skip-cat.pdf', '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId);
    const statementId = Number(stmt.lastInsertRowid);
    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag,
           parser_row_id, origin_card_last4
         ) VALUES (?, '19/05/2026', 'Adicional skip category fixture', 1000, 0, 'vitest-addl-skip-cat', '4999')`
      )
      .run(statementId);
    const lineId = Number(line.lastInsertRowid);
    const purchaseKey = resolveCcExpensePurchaseKey(lineId);
    const othersId = getCcExpenseCategoryBySlug("others")?.id;
    expect(othersId).toBeTruthy();

    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
    ).run(accountId, purchaseKey, othersId);

    const result = applyAdditionalCardNoCuentaForLine({
      accountId,
      statementLineId: lineId,
      originCardLast4: "4999",
      primaryCardLast4: "4242",
    });
    expect(result.skippedExistingCategory).toBe(true);
    expect(result.applied).toBe(false);

    const row = db
      .prepare(
        `SELECT c.slug FROM cc_expense_unique_purchases up
         JOIN cc_expense_categories c ON c.id = up.category_id
         WHERE up.account_id = ? AND up.purchase_key = ?`
      )
      .get(accountId, purchaseKey) as { slug: string } | undefined;
    expect(row?.slug).toBe("others");

    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(
      accountId,
      purchaseKey
    );
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});
