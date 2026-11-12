import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createManualExpense } from "./flowsManualExpenses.js";
import { ensureVitestCreditCardFixtures, getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  listCcExpenseBigGroups,
  loadCcExpensePurchaseBigGroups,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
  slugFromBigGroupLabel,
} from "./ccExpenseBigGroups.js";

describe("ccExpenseBigGroups", () => {
  it("creates slug from label with dedupe suffix", () => {
    const slug = slugFromBigGroupLabel("Vacaciones NZ 2023");
    expect(slug).toMatch(/^vacaciones_nz_2023/);
  });

  it("keys a big group by the purchase alone, manual expenses included", () => {
    const group = createCcExpenseBigGroup(`Vitest trip ${Date.now()}`);
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId()!;
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, layout, currency)
           VALUES (?, 'A', 'vitest big group.pdf', '24/09/2026', 'compact', 'clp')`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id)
       VALUES (?, '03/09/2026', 'VITEST BIG GROUP', 1000, 0, 'vitest-big-group', 'vitest-big-group')`
    ).run(statementId);
    const manual = createManualExpense({
      spent_on: "2026-09-03",
      amount: 1000,
      currency: "clp",
      category_slug: "unclassified",
      description: "vitest big group",
    });
    const keys = ["line-pr:vitest-big-group", `manual:${manual.id}`];
    try {
      for (const purchaseKey of keys) {
        setCcExpensePurchaseBigGroup({ purchaseKey, groupSlug: group.slug });
        expect(loadCcExpensePurchaseBigGroups().get(purchaseKey)).toBe(group.slug);
      }
      expect(() =>
        setCcExpensePurchaseBigGroup({ purchaseKey: "payslip:900000001", groupSlug: group.slug })
      ).toThrow(/payroll/);
      // A purchase key names a flow: one no document records takes no big group.
      expect(() => setCcExpensePurchaseBigGroup({ purchaseKey: "line-pr:vitest-no-such-line", groupSlug: group.slug })).toThrow(
        /no expense carries/
      );
      for (const purchaseKey of keys) setCcExpensePurchaseBigGroup({ purchaseKey, groupSlug: null });
      deleteCcExpenseBigGroup(group.slug);
      expect(listCcExpenseBigGroups().some((g) => g.slug === group.slug)).toBe(false);
    } finally {
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(manual.id);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
      db.prepare(`DELETE FROM flows WHERE legacy_key IN (${keys.map(() => "?").join(",")})`).run(...keys);
    }
  });

  it("renames a big group", () => {
    const group = createCcExpenseBigGroup(`Rename me ${Date.now()}`);
    const renamed = renameCcExpenseBigGroup(group.slug, "Renamed label");
    expect(renamed.label).toBe("Renamed label");
    deleteCcExpenseBigGroup(group.slug);
  });
});
