import { insertLines } from "./cards/lineWrites.js";
import type { CcListingParseResult } from "./ccWebPasteParse.js";

const plantFinancingPayment = (accountId: number, parsed: CcListingParseResult) => {
  insertLines(accountId, parsed, "cc_financing_payment");
};
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { applyFacturadoFinancingLinks, planFacturadoFinancingLinks } from "./ccFacturadoFinancingAuto.js";
import { listCcFacturadoFinancingLinks, deleteCcFacturadoFinancingLink } from "./ccFacturadoFinancingLinksDb.js";
import { resolveCcExpensePurchaseKey, getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { deleteFlowCategory, getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);
afterAll(() => restoreDerivedCardState());

const TAG = "vitest-fin-auto";
let financed = 0;
let financing = 0;

function master(importKeyLike: string): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key LIKE ? ORDER BY id LIMIT 1`).get(importKeyLike) as
    | { id: number }
    | undefined;
  return row?.id ?? 0;
}

function plan(key: string, date: string, total: number): void {
  db.prepare(
    `INSERT INTO cc_installment_purchases
       (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
     VALUES (?, 'A', ?, ?, ?, 3, ?, 'manual')`
  ).run(financing, `${TAG}|${key}`, date, total, `${TAG} RECAUDACION ${key}`);
}

/** A one-shot charge on the financing card, on a synthetic statement of its own. */
function oneShot(key: string, ddmmyyyy: string, merchant: string, amount: number): number {
  const stmt = db
    .prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency)
       VALUES (?, 'A', ?, ?, 'clp')`
    )
    .run(financing, `${TAG}|oneshot-${key}.pdf`, ddmmyyyy);
  return Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, kind, dedupe_key, raw_line)
         VALUES (?, ?, ?, ?, 0, 'card_purchase', ?, ?)`
      )
      .run(stmt.lastInsertRowid, ddmmyyyy, merchant, amount, `${TAG}|${key}`, `${ddmmyyyy} ${merchant} ${amount}`).lastInsertRowid
  );
}

function cleanup(): void {
  for (const r of db
    .prepare(
      `SELECT l.id, s.account_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.source_pdf LIKE ?`
    )
    .all(`${TAG}|oneshot-%`) as { id: number; account_id: number }[]) {
    deleteFlowCategory(r.account_id, resolveCcExpensePurchaseKey(r.id));
  }
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ? AND source_pdf LIKE ?`).run(financing, `${TAG}|oneshot-%`);
  for (const l of listCcFacturadoFinancingLinks()) {
    if (l.financed_account_id === financed && l.financed_billing_month.startsWith("2036")) deleteCcFacturadoFinancingLink(l.id);
  }
  db.prepare(`DELETE FROM cc_installment_purchases WHERE canonical_row_id LIKE ?`).run(`${TAG}|%`);
  // The planted PAGO lands in the card's current open bucket, which holds other lines.
  db.prepare(
    `DELETE FROM cc_statement_lines
     WHERE merchant = 'PAGO' AND amount_clp IN (-2467034, -1234567, -812345) AND (transaction_date LIKE '%/2036' OR transaction_date LIKE '%/2037')
       AND statement_id IN (SELECT id FROM cc_statements WHERE account_id = ? AND source_kind IN ('listing_open', 'listing_other'))`
  ).run(financed);
  db.prepare(
    `DELETE FROM cc_statements WHERE account_id = ? AND (source_pdf LIKE ? OR (source_kind IN ('listing_open', 'listing_other') AND (statement_date LIKE '%/2036' OR statement_date LIKE '%/2037')))`
  ).run(financed, `${TAG}|%`);
}

describe("facturado paid with another card's cuotas", () => {
  beforeAll(() => {
    financed = master("credit_card_master|bci|%");
    financing = master("credit_card_master|santander|%");
    if (!financed || !financing) return;
    cleanup();
    // The paid card's closed facturado: 2.xxx.xxx, closed 26/06/2036, due 10/07/2036.
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, pay_by, currency, monto_facturado)
       VALUES (?, 'A', ?, '26/06/2036', '10/07/2036', 'clp', 2467034)`
    ).run(financed, `${TAG}|2036-06.pdf`);
    // Paid on 30/06 as two cuota purchases on the other card, plus an unrelated one that day.
    plan("a", "2036-06-30", 1_200_000);
    plan("b", "2036-06-30", 1_267_034);
    plan("other", "2036-06-30", 99_990);
    // Before the close: cannot have paid it.
    plan("early", "2036-06-20", 2_467_034);
  });

  afterAll(cleanup);

  it("finds the one combination of a day's cuota purchases that adds up to the facturado", () => {
    if (!financed || !financing) return;
    const m = planFacturadoFinancingLinks().matches.filter((x) => x.financed_account_id === financed && x.financed_billing_month === "2036-06");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ facturado_clp: 2_467_034, paid_on: "2036-06-30", status: "link", payment_on_file: false });
    expect(m[0]!.payments.map((p) => p.principal_clp).sort()).toEqual([1_200_000, 1_267_034]);
  });

  it("links them and plants the PAGO once", () => {
    if (!financed || !financing) return;
    const applied = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(applied.links_created).toContainEqual({ financed_account_id: financed, financed_billing_month: "2036-06" });
    expect(applied.payments_planted).toContainEqual({ financed_account_id: financed, paid_on: "2036-06-30", amount_clp: 2_467_034 });

    const link = listCcFacturadoFinancingLinks().find((l) => l.financed_account_id === financed && l.financed_billing_month === "2036-06");
    expect(link?.financing).toHaveLength(2);
    const pago = db
      .prepare(
        `SELECT l.amount_clp FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant = 'PAGO' AND l.amount_clp = -2467034`
      )
      .all(financed) as { amount_clp: number }[];
    expect(pago.map((p) => p.amount_clp)).toEqual([-2_467_034]);

    // A second pass finds the month linked and the payment on file: nothing more.
    const again = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(again.links_created.filter((l) => l.financed_account_id === financed)).toEqual([]);
    expect(again.payments_planted.filter((p) => p.financed_account_id === financed)).toEqual([]);
  });

  it("leaves a facturado two combinations could have paid alone", () => {
    if (!financed || !financing) return;
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, pay_by, currency, monto_facturado)
       VALUES (?, 'A', ?, '26/08/2036', '10/09/2036', 'clp', 300000)`
    ).run(financed, `${TAG}|2036-08.pdf`);
    plan("x1", "2036-08-28", 300_000);
    plan("x2", "2036-08-29", 300_000);
    const p = planFacturadoFinancingLinks();
    expect(p.matches.some((m) => m.financed_account_id === financed && m.financed_billing_month === "2036-08")).toBe(false);
    expect(p.ambiguous).toContainEqual({
      financed_account_id: financed,
      financed_billing_month: "2036-08",
      reason: "2 combinations of purchases add up to the facturado",
    });
  });
});

describe("facturado paid in one charge on another card", () => {
  beforeAll(() => {
    financed = master("credit_card_master|bci|%");
    financing = master("credit_card_master|santander|%");
    if (!financed || !financing) return;
    cleanup();
    // The paid card's closed facturado: 1.xxx.xxx, closed 26/10/2036, due 10/11/2036.
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, pay_by, currency, monto_facturado)
       VALUES (?, 'A', ?, '26/10/2036', '10/11/2036', 'clp', 1234567)`
    ).run(financed, `${TAG}|2036-10.pdf`);
  });

  afterAll(cleanup);

  it("ignores a charge of the same pesos somewhere the card is not paid at", () => {
    if (!financed || !financing) return;
    oneShot("shop", "05/11/2036", "FALABELLA COSTANERA", 1_234_567);
    const m = planFacturadoFinancingLinks().matches.filter((x) => x.financed_account_id === financed && x.financed_billing_month === "2036-10");
    expect(m).toEqual([]);
  });

  it("takes one charge at a Lider store for the whole facturado as its payment", () => {
    if (!financed || !financing) return;
    // A grocery purchase the same day, and one before the close, are not the payment.
    oneShot("groceries", "05/11/2036", "EXPRESS PLAZA L", 23_480);
    oneShot("early", "20/10/2036", "EXPRESS PLAZA L", 1_234_567);
    const lineId = oneShot("pay", "05/11/2036", "EXPRESS PLAZA L", 1_234_567);
    const m = planFacturadoFinancingLinks().matches.filter((x) => x.financed_account_id === financed && x.financed_billing_month === "2036-10");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ facturado_clp: 1_234_567, paid_on: "2036-11-05", status: "one_shot", payment_on_file: false });
    expect(m[0]!.payments.map((p) => (p as { line_id?: number }).line_id)).toEqual([lineId]);

    const applied = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(applied.links_created.filter((l) => l.financed_account_id === financed && l.financed_billing_month === "2036-10")).toEqual([]);
    expect(applied.payments_planted).toContainEqual({ financed_account_id: financed, paid_on: "2036-11-05", amount_clp: 1_234_567 });
    expect(applied.lines_filed_as_transfer).toContainEqual({
      account_id: financing,
      line_id: lineId,
      financed_account_id: financed,
      financed_billing_month: "2036-10",
    });
    const transfer = getCcExpenseCategoryBySlug("checking_internal_transfer")!;
    expect(getFlowCategory(financing, resolveCcExpensePurchaseKey(lineId))).toEqual({ category_id: transfer.id });

    // Again: the PAGO is on file and the line already filed.
    const again = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(again.payments_planted.filter((p) => p.financed_account_id === financed)).toEqual([]);
    expect(again.lines_filed_as_transfer.filter((l) => l.financed_account_id === financed)).toEqual([]);
  });

  it("leaves a second charge that also fits alone", () => {
    if (!financed || !financing) return;
    oneShot("twin", "06/11/2036", "EXPRESS PLAZA L", 1_234_567);
    const p = planFacturadoFinancingLinks();
    expect(p.matches.some((m) => m.financed_account_id === financed && m.financed_billing_month === "2036-10")).toBe(false);
    expect(p.ambiguous).toContainEqual({
      financed_account_id: financed,
      financed_billing_month: "2036-10",
      reason: "2 combinations of purchases add up to the facturado",
    });
  });

  it("plants the PAGO but keeps a category the user gave the line", () => {
    if (!financed || !financing) return;
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, pay_by, currency, monto_facturado)
       VALUES (?, 'A', ?, '26/12/2036', '10/01/2037', 'clp', 812345)`
    ).run(financed, `${TAG}|2036-12.pdf`);
    const lineId = oneShot("mine", "04/01/2037", "RECAUDACION EX PLAZA LYON", 812_345);
    const key = resolveCcExpensePurchaseKey(lineId);
    putFlowCategory(financing, key, null, "replace");
    const applied = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(applied.payments_planted).toContainEqual({ financed_account_id: financed, paid_on: "2037-01-04", amount_clp: 812_345 });
    expect(applied.lines_filed_as_transfer.filter((l) => l.line_id === lineId)).toEqual([]);
    expect(getFlowCategory(financing, key)).toEqual({ category_id: null });
  });
});
