import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  convertStatementLineToInstallmentPurchase,
  createManualCcInstallmentPurchase,
} from "./ccInstallmentManual.js";
import { buildCcExpenseLines } from "./flowsExpenses.js";
import { loadCcExpenseCategoryMaps } from "./ccExpenseCategories.js";
import { mergeInstallmentPurchaseTotalsIntoLines } from "./ccInstallmentPurchaseTotalLines.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

function insertStatement(accountId: number, suffix: string): number {
  const r = db
    .prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
         card_last4, card_product, layout, currency,
         saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
       ) VALUES (?, 'A', ?, '30/06/2026', '2026-06-01', '2026-06-30', '10/07/2026',
         '0000', NULL, 'compact', 'clp', 0, 0, 0, 0, NULL)`
    )
    .run(accountId, `${suffix}.pdf`);
  return Number(r.lastInsertRowid);
}

function insertOneShotLine(
  statementId: number,
  merchant: string,
  amountClp: number,
  parserRowId: string
): number {
  db.prepare(
    `INSERT INTO cc_statement_lines (
       statement_id, transaction_date, posting_date, place, merchant, description_merged,
       country, amount_orig, orig_currency, amount, currency, installment_flag,
       nro_cuota_current, nro_cuota_total, cuota_amount,
       interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line
     ) VALUES (?, '30/06/2026', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, 'clp', 0,
       NULL, NULL, NULL, NULL, NULL, ?, ?, 'raw')`
  ).run(statementId, merchant, amountClp, `dedupe-${parserRowId}`, parserRowId);
  return (
    db
      .prepare(`SELECT id FROM cc_statement_lines WHERE parser_row_id = ?`)
      .get(parserRowId) as { id: number }
  ).id;
}

describe("convertStatementLineToInstallmentPurchase", () => {
  let statementId: number | null = null;
  let accountId: number | null = null;

  afterEach(() => {
    if (statementId != null) {
      db.prepare(`DELETE FROM cc_installment_purchases WHERE source_line_id IN (SELECT id FROM cc_statement_lines WHERE statement_id = ?)`).run(statementId);
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
    }
    if (accountId != null) {
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id LIKE 'manual-%'`).run(
        accountId
      );
    }
    statementId = null;
    accountId = null;
  });

  it("keeps the converted line under its plan, and its same-merchant/same-day sibling", () => {
    ensureVitestCreditCardFixtures();
    accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const suffix = `convert-line-${Date.now()}`;
    statementId = insertStatement(accountId, suffix);
    // Two distinct purchases: identical merchant + date, different amounts within 2% tolerance
    // would previously collide via fuzzy dedupe. EXPRESS PLAZA L is special-cased too.
    const lineA = insertOneShotLine(statementId, "EXPRESS PLAZA L", 1_267_034, `${suffix}-a`);
    const lineB = insertOneShotLine(statementId, "EXPRESS PLAZA L", 1_200_000, `${suffix}-b`);

    convertStatementLineToInstallmentPurchase(accountId, lineA, 12);

    const aStill = db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(lineA);
    const bStill = db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(lineB);
    expect(aStill).toBeDefined(); // converted -> kept, the plan overlays it
    expect(bStill).toBeDefined(); // sibling survives

    const purchases = db
      .prepare(
        `SELECT total_amount_clp, source_line_id FROM cc_installment_purchases
         WHERE account_id = ? AND canonical_row_id LIKE 'manual-%'`
      )
      .all(accountId) as { total_amount_clp: number; source_line_id: number | null }[];
    expect(purchases).toHaveLength(1);
    expect(purchases[0].total_amount_clp).toBe(1_267_034);
    expect(purchases[0].source_line_id).toBe(lineA);

    // The expense is the plan's: the converted line no longer lists as a one-shot.
    const lines = buildCcExpenseLines([accountId]);
    expect(lines.some((l) => l.statement_line_id === lineA)).toBe(false);
    expect(lines.some((l) => l.statement_line_id === lineB)).toBe(true);
    expect(() => convertStatementLineToInstallmentPurchase(accountId!, lineA, 3)).toThrow(/already converted/);
  });

  it("keeps both lines when a sibling has an identical amount too", () => {
    ensureVitestCreditCardFixtures();
    accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    const suffix = `convert-line-dup-${Date.now()}`;
    statementId = insertStatement(accountId, suffix);
    const lineA = insertOneShotLine(statementId, "EXPRESS PLAZA L", 1_200_000, `${suffix}-a`);
    const lineB = insertOneShotLine(statementId, "EXPRESS PLAZA L", 1_200_000, `${suffix}-b`);

    convertStatementLineToInstallmentPurchase(accountId, lineA, 6);

    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(lineA)).toBeDefined();
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(lineB)).toBeDefined();

    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM cc_installment_purchases
           WHERE account_id = ? AND canonical_row_id LIKE 'manual-%'`
        )
        .get(accountId) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("shows two distinct installment totals for same-merchant/same-day/same-cuotas purchases", () => {
    ensureVitestCreditCardFixtures();
    accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;

    // Two EXPRESS PLAZA L charges on 30/06, both turned into 3-cuota installments but with
    // different amounts. They share account+date+cuotas+merchant; the display must not collapse
    // them into a single total.
    createManualCcInstallmentPurchase(accountId, {
      purchase_date: "2026-06-30",
      total_amount_clp: 1_200_000,
      cuotas_totales: 3,
      merchant: "ZZ Convert Collision L",
    });
    createManualCcInstallmentPurchase(accountId, {
      purchase_date: "2026-06-30",
      total_amount_clp: 1_267_034,
      cuotas_totales: 3,
      merchant: "ZZ Convert Collision L",
    });

    const merged = mergeInstallmentPurchaseTotalsIntoLines(
      buildCcExpenseLines([accountId]),
      [accountId],
      loadCcExpenseCategoryMaps([accountId])
    );
    const totals = merged
      .filter(
        (l) =>
          l.line_role === "installment_purchase_total" &&
          String(l.merchant ?? "").includes("Convert Collision")
      )
      .map((l) => l.amount_clp)
      .sort((a, b) => a - b);

    expect(totals).toEqual([1_200_000, 1_267_034]);
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});
