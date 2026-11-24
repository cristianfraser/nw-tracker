import { FLOW_CATEGORY_ROWS_SQL, uniqueCategoryInsert } from "./test/flowFixtures.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  ADDITIONAL_CARD_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { installmentHKeyWithoutTotal } from "./expenseKeys.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { db } from "./db.js";
import { flowCcExpenseLineFingerprint } from "./ccExpenseLineDedupe.js";
import { buildFlowsExpenseLines, buildFlowsExpensesPayload, resolveExpenseMonth } from "./flowsExpenses.js";
import { gastosSumMonthForLine } from "./ccExpensePeriodMonth.js";
import { hasSplittableMortgageExpenseDepositLink } from "./expenseDepositLinks.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";
import { aggregateGastosFromLines, countsTowardGastosMes, gastosMonthRows } from "./flowsExpensesGastos.js";
import { lineAmountClpSql, lineAmountUsdSql, lineCuotaClpSql } from "./cards/lineAmountSql.js";

/** The Vitest person's installment contract (`demoData/person.ts`: 6 cuotas on its main card). */
const TEST_PERSON_INSTALLMENT_MERCHANT = "MAC STORE PRUEBA";

/** Por cuota's month rows (the flows overview's expenses leg), its total and category stacks, in CLP. */
function splitView(payload: ReturnType<typeof buildFlowsExpensesPayload>) {
  const lines = buildFlowsExpenseLines(payload.account_ids);
  const agg = aggregateGastosFromLines(lines, payload.categories.map((c) => c.slug), "split", undefined, "clp");
  return { by_month: gastosMonthRows(lines, "split", "clp"), total: agg.total, chart_monthly_by_category: agg.chart_monthly_by_category };
}

describe("resolveExpenseMonth", () => {
  it("prefers purchase date over statement close for one-shot charges", () => {
    expect(resolveExpenseMonth("2025-02-10", "2025-04-22", "2025-04")).toBe("2025-02");
  });

  it("uses billing month for installment cuotas", () => {
    expect(
      resolveExpenseMonth("2025-02-27", "2025-07-24", "2025-07", { installment: true })
    ).toBe("2025-07");
  });
});

describe("flowsExpenses", () => {
  const SRC_ADDITIONAL_FIXTURE = "import:web-paste|vitest-flows-additional-card";

  function cleanupAdditionalFixture(): void {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
         SELECT id FROM cc_statements WHERE source_pdf = ?
       )`
    ).run(SRC_ADDITIONAL_FIXTURE);
    db.prepare(`DELETE FROM cc_statements WHERE source_pdf = ?`).run(SRC_ADDITIONAL_FIXTURE);
    // Unique purchase rows (and notes) are keyed by purchase_key; delete any that reference our parser row ids.
    db.prepare(
      `DELETE FROM flow_notes
       WHERE flow_id IN (SELECT id FROM flows WHERE legacy_key LIKE 'line-pr:vitest-addl-%')`
    ).run();
    db.prepare(
      `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE purchase_key LIKE 'line-pr:vitest-addl-%')`
    ).run();
  }

  afterEach(() => cleanupAdditionalFixture());

  it("listCreditCardMasterAccountIds drives the gastos payload", () => {
    const payload = buildFlowsExpensesPayload();
    const allowed = new Set(listCreditCardMasterAccountIds());
    expect(payload.account_ids.length).toBeGreaterThan(0);
    expect(payload.lines.some((ln) => ln.source === "cc")).toBe(true);
    for (const id of payload.account_ids) {
      expect(allowed.has(id)).toBe(true);
    }
    for (const ln of payload.lines) {
      if (ln.source !== "cc") continue;
      expect(allowed.has(ln.account_id)).toBe(true);
    }
  });

  it("auto-tags adicional-card lines as additional_card + unique in the payload", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    expect(accountId).not.toBeNull();
    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC_ADDITIONAL_FIXTURE);
    const statementId = Number(stmt.lastInsertRowid);

    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag,
           parser_row_id, origin_card_last4, dedupe_key
         ) VALUES (?, '19/05/2026', 'Additional card payload fixture', 12345, 0, ?, '4999', ?)`
      )
      .run(statementId, parserRowId, `vitest-addl-dedupe-${parserRowId}`);
    const lineId = Number(line.lastInsertRowid);

    const payload = buildFlowsExpensesPayload();
    const found = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === lineId);
    expect(found).toBeDefined();
    expect(found!.category_slug).toBe(ADDITIONAL_CARD_CC_EXPENSE_SLUG);
    expect(found!.category_unique).toBe(true);
    expect(found!.origin_card_last4).toBe("4999");
    expect(found!.primary_card_last4).toBe("4242");
  });

  it("does not force the additional_card category when the user cleared unique category", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    expect(accountId).not.toBeNull();
    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC_ADDITIONAL_FIXTURE);
    const statementId = Number(stmt.lastInsertRowid);

    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag,
           parser_row_id, origin_card_last4, dedupe_key
         ) VALUES (?, '19/05/2026', 'Additional card cleared fixture', 22222, 0, ?, '4999', ?)`
      )
      .run(statementId, parserRowId, `vitest-addl-dedupe-${parserRowId}`);
    const lineId = Number(line.lastInsertRowid);

    const purchaseKey = resolveCcExpensePurchaseKey(lineId);
    const additionalCardId = getCcExpenseCategoryBySlug(ADDITIONAL_CARD_CC_EXPENSE_SLUG)?.id;
    expect(additionalCardId).toBeTruthy();

    // Simulate user-cleared unique: category_id NULL exists in DB at load.
    uniqueCategoryInsert.run(accountId!, purchaseKey, null);

    const payload = buildFlowsExpensesPayload();
    const found = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === lineId);
    expect(found).toBeDefined();

    // We should not override to additional_card when the user explicitly cleared unique.
    expect(found!.category_slug).not.toBe(ADDITIONAL_CARD_CC_EXPENSE_SLUG);
  });

  it("never auto-tags installment contracts as additional_card for adicional cuotas", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    expect(accountId).not.toBeNull();
    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC_ADDITIONAL_FIXTURE);
    const statementId = Number(stmt.lastInsertRowid);

    // Cuota 1 of 3 bought on the adicional plastic (·4999) of the ·4242 statement.
    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag,
           nro_cuota_current, nro_cuota_total, cuota_amount,
           parser_row_id, origin_card_last4, dedupe_key
         ) VALUES (?, '10/05/2026', 'Additional card installment fixture', 10000, 1, 1, 3, 10000, ?, '4999', ?)`
      )
      .run(statementId, parserRowId, `vitest-addl-dedupe-${parserRowId}`);
    const lineId = Number(line.lastInsertRowid);

    const payload = buildFlowsExpensesPayload();
    const found = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === lineId);
    expect(found).toBeDefined();
    expect(found!.installment_flag).toBe(1);
    expect(found!.line_role).toBe("installment_cuota");
    expect(found!.origin_card_last4).toBe("4999");
    expect(found!.primary_card_last4).toBe("4242");
    expect(found!.category_slug).not.toBe(ADDITIONAL_CARD_CC_EXPENSE_SLUG);
    expect(found!.category_unique).toBe(false);
  });

  it("keeps user unique category on installment contract when an adicional cuota exists", () => {
    const payload = buildFlowsExpensesPayload();
    const titularCuota = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        // Real statement line only — synthesized contract/total lines carry negative ids
        // and cannot be assigned/resolved through the statement-line APIs.
        ln.statement_line_id > 0 &&
        ln.installment_flag === 1 &&
        ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT) &&
        ln.nro_cuota_current === 1 &&
        ln.origin_card_last4 === ln.primary_card_last4
    );
    expect(titularCuota).toBeDefined();

    const purchaseKey = resolveCcExpensePurchaseKey(titularCuota!.statement_line_id);
    expect(purchaseKey).toMatch(/^installment-h:/);

    // Snapshot + restore: assignments persist in the shared DB and leaked into the
    // clear_category test below (and into future suite runs).
    const prior = db
      .prepare(
        `SELECT category_id FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?`
      )
      .get(titularCuota!.account_id, purchaseKey) as { category_id: number | null } | undefined;

    try {
      assignFlowExpenseLineCategory({
        source: "cc",
        lineId: titularCuota!.statement_line_id,
        unique: true,
        categorySlug: "others",
      });

      const after = buildFlowsExpensesPayload();
      const contractLines = after.lines.filter(
        (ln) =>
          ln.source === "cc" &&
          ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT) &&
          (ln.line_role === "installment_cuota" || ln.line_role === "installment_purchase_total")
      );
      expect(contractLines.length).toBeGreaterThan(0);
      for (const ln of contractLines) {
        expect(ln.category_slug).toBe("others");
      }

      const row = db
        .prepare(
          `SELECT c.slug FROM ${FLOW_CATEGORY_ROWS_SQL} up
           JOIN cc_expense_categories c ON c.id = up.category_id
           WHERE up.account_id = ? AND up.purchase_key = ?`
        )
        .get(titularCuota!.account_id, purchaseKey) as { slug: string } | undefined;
      expect(row?.slug).toBe("others");
    } finally {
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(titularCuota!.account_id, purchaseKey);
      if (prior) {
        uniqueCategoryInsert.run(titularCuota!.account_id, purchaseKey, prior.category_id);
      }
    }
  });

  it("clear_category on installment contract stays unclassified after rebuild", () => {
    const payload = buildFlowsExpensesPayload();
    const titularCuota = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        // Real statement line only — synthesized contract/total lines carry negative ids
        // and cannot be assigned/resolved through the statement-line APIs.
        ln.statement_line_id > 0 &&
        ln.installment_flag === 1 &&
        ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT) &&
        ln.nro_cuota_current === 1 &&
        ln.origin_card_last4 === ln.primary_card_last4
    );
    expect(titularCuota).toBeDefined();

    const purchaseKey = resolveCcExpensePurchaseKey(titularCuota!.statement_line_id);
    const legacyKey = installmentHKeyWithoutTotal(purchaseKey);
    const snapshotKey = (key: string | null) =>
      key
        ? (db
            .prepare(
              `SELECT category_id FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?`
            )
            .get(titularCuota!.account_id, key) as { category_id: number | null } | undefined)
        : undefined;
    const prior = snapshotKey(purchaseKey);
    const priorLegacy = snapshotKey(legacyKey);

    try {
      assignFlowExpenseLineCategory({
        source: "cc",
        lineId: titularCuota!.statement_line_id,
        unique: true,
        categorySlug: "others",
      });

      assignFlowExpenseLineCategory({
        source: "cc",
        lineId: titularCuota!.statement_line_id,
        unique: true,
        clearCategory: true,
      });

      for (let i = 0; i < 2; i++) {
        const after = buildFlowsExpensesPayload();
        const contractLines = after.lines.filter(
          (ln) =>
            ln.source === "cc" &&
            ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT) &&
            (ln.line_role === "installment_cuota" || ln.line_role === "installment_purchase_total")
        );
        expect(contractLines.length).toBeGreaterThan(0);
        for (const ln of contractLines) {
          expect(ln.category_slug).toBe("unclassified");
        }
      }
    } finally {
      const restoreKey = (
        key: string | null,
        snap: { category_id: number | null } | undefined
      ) => {
        if (!key) return;
        db.prepare(
          `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
        ).run(titularCuota!.account_id, key);
        if (snap) {
          uniqueCategoryInsert.run(titularCuota!.account_id, key, snap.category_id);
        }
      };
      restoreKey(purchaseKey, prior);
      restoreKey(legacyKey, priorLegacy);
    }
  });

  it("builds monthly rows with cumulative gastos when statement lines exist", () => {
    const payload = buildFlowsExpensesPayload();
    expect(payload.group_slug).toBe("credit_cards");
    const byMonth = splitView(payload).by_month;
    expect(byMonth.length).toBeGreaterThan(0);

    const asc = [...byMonth].reverse();
    let expected = 0;
    for (const row of asc) {
      expected += row.gastos_mes;
      expect(row.gastos_acumulado).toBe(expected);
      expect(row.period_month).toMatch(/^\d{4}-\d{2}$/);
      expect(row.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // The chart stacks run on the same month rows.
    const view = splitView(payload);
    const byMonthMap = new Map(asc.map((r) => [r.period_month, r]));
    for (const point of view.chart_monthly_by_category) {
      expect(byMonthMap.has(point.as_of_date.slice(0, 7))).toBe(true);
    }
  });

  it("groups installment lines by billing month, not purchase month", () => {
    const payload = buildFlowsExpensesPayload();
    const cuotas = payload.lines.filter(
      (ln) =>
        ln.source === "cc" &&
        ln.statement_line_id > 0 &&
        ln.line_role === "installment_cuota" &&
        ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT)
    );
    // The Vitest person's contract: one purchase day, six cuotas billed one a month.
    expect(cuotas.map((ln) => ln.nro_cuota_current).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(cuotas.map((ln) => ln.purchase_on)).size).toBe(1);
    for (const ln of cuotas) {
      expect(ln.installment_flag).toBe(1);
      expect(ln.expense_month).toBe(ln.billing_month);
    }
    const months = [...new Set(cuotas.map((ln) => ln.expense_month))].sort();
    expect(months).toHaveLength(6);
    const purchaseMonth = cuotas[0]!.purchase_on!.slice(0, 7);
    expect(months.filter((m) => m === purchaseMonth).length).toBeLessThanOrEqual(1);
  });

  it("does not count installment purchase totals toward gastos in split mode", () => {
    const payload = buildFlowsExpensesPayload();
    const totals = payload.lines.filter(
      (ln) => ln.line_role === "installment_purchase_total" && ln.value_clp > 0
    );
    expect(totals.some((ln) => ln.merchant_key.includes(TEST_PERSON_INSTALLMENT_MERCHANT))).toBe(true);

    for (const ln of totals) {
      expect(gastosSumMonthForLine(ln, "split")).toBe("");
      expect(countsTowardGastosMes(ln, "split")).toBe(false);
    }
  });

  it("includes checking gastos lines when cuenta corriente is configured", () => {
    const payload = buildFlowsExpensesPayload();
    const checking = payload.lines.filter((ln) => ln.source === "checking");
    expect(checking.length).toBeGreaterThan(0);
  });

  it("gastos_mes reflects NOTA DE CREDITO pairing and unmatched adjustments", () => {
    const payload = buildFlowsExpensesPayload();
    expect(splitView(payload).by_month.length).toBeGreaterThan(0);
    for (const row of splitView(payload).by_month) {
      const monthLines = payload.lines.filter(
        (ln) => gastosSumMonthForLine(ln, "split") === row.period_month
      );
      const sumPositive = monthLines
        .filter(
          (ln) =>
            (ln.value_clp > 0 || ln.checking_refund === true) &&
            ln.nota_credito_role !== "annulled_purchase" &&
            ln.nota_credito_role !== "matched_nota" &&
            ln.nota_credito_role !== "unmatched_nota"
        )
        .reduce((s, ln) => s + ln.value_clp, 0);
      const sumCounted = monthLines.reduce((s, ln) => {
        if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
          return s;
        }
        if (ln.nota_credito_role === "unmatched_nota") return s + ln.value_clp;
        if (countsTowardGastosMes(ln, "split")) {
          // Mortgage-linked lines contribute only the carrying portion (deuda amortization
          // is tracked separately), matching the production aggregateGastosFromLines logic.
          const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
          const mortgageSplit = hasSplittableMortgageExpenseDepositLink(link);
          return s + (mortgageSplit ? link.carrying_clp : ln.value_clp);
        }
        return s;
      }, 0);
      expect(row.gastos_real_mes).toBe(Math.round(sumPositive));
      expect(row.gastos_mes).toBe(Math.round(sumCounted));
    }
  });

  it("includes USD-only statement lines converted to CLP", () => {
    const accountIds = listCreditCardMasterAccountIds();
    expect(accountIds.length).toBeGreaterThan(0);
    const ph = accountIds.map(() => "?").join(",");
    const usdOnlyIds = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id IN (${ph})
           AND (${lineAmountUsdSql("l")} IS NOT NULL AND ${lineAmountUsdSql("l")} != 0)
           AND (${lineAmountClpSql("l")} IS NULL OR ${lineAmountClpSql("l")} = 0)
           AND NOT (l.installment_flag = 1 AND ${lineCuotaClpSql("l")} IS NOT NULL AND ${lineCuotaClpSql("l")} != 0)`
      )
      .all(...accountIds) as { id: number }[];
    // The Vitest person's dollar purchase («HOTEL PRUEBA» on its second card).
    expect(usdOnlyIds.length).toBeGreaterThan(0);

    const payload = buildFlowsExpensesPayload();
    const included = new Set(payload.lines.map((ln) => ln.statement_line_id));
    const matched = usdOnlyIds.filter((r) => included.has(r.id));
    expect(matched.length).toBeGreaterThan(usdOnlyIds.length * 0.5);
    expect(splitView(payload).total).toBeGreaterThan(0);
    const usdIncludedClp = payload.lines
      .filter(
        (ln) =>
          ln.value_clp > 0 &&
          usdOnlyIds.some((r) => r.id === ln.statement_line_id)
      )
      .reduce((s, ln) => s + ln.value_clp, 0);
    expect(usdIncludedClp).toBeGreaterThan(0);
  });

  it("lands each facturación's cuotas on the pay-by its facturaciones row shows", () => {
    const payload = buildFlowsExpensesPayload();
    let rows = 0;
    for (const accountId of payload.account_ids) {
      for (const f of billingDetailCacheForAccount(accountId).facturaciones) {
        expect(payload.cuota_pay_by_iso?.[`${accountId}|${f.billing_month}`]).toBe(f.pay_by_iso);
        rows += 1;
      }
    }
    expect(rows).toBeGreaterThan(0);
    expect(Object.keys(payload.cuota_pay_by_iso ?? {})).toHaveLength(rows);
  });

  it("has no duplicate gastos fingerprints on credit card lines", () => {
    // The fingerprint reads the builder pesos: the server-side lines, not the wire payload.
    const seen = new Set<string>();
    for (const ln of buildFlowsExpenseLines().filter(
      (l) =>
        l.source === "cc" &&
        l.amount_clp > 0 &&
        l.line_role !== "installment_purchase_total"
    )) {
      const fp = flowCcExpenseLineFingerprint(ln);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});
