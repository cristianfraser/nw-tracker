import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { applyFacturadoFinancingLinks, planFacturadoFinancingLinks } from "./ccFacturadoFinancingAuto.js";
import { listCcFacturadoFinancingLinks, deleteCcFacturadoFinancingLink } from "./ccFacturadoFinancingLinksDb.js";

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

function cleanup(): void {
  for (const l of listCcFacturadoFinancingLinks()) {
    if (l.financed_account_id === financed && l.financed_billing_month.startsWith("2036")) deleteCcFacturadoFinancingLink(l.id);
  }
  db.prepare(`DELETE FROM cc_installment_purchases WHERE canonical_row_id LIKE ?`).run(`${TAG}|%`);
  db.prepare(
    `DELETE FROM cc_statements WHERE account_id = ? AND (source_pdf LIKE ? OR (source_pdf LIKE 'import:web-paste%' AND statement_date LIKE '%/2036'))`
  ).run(financed, `${TAG}|%`);
  if (financed) invalidateCcBillingDetail(financed);
  if (financing) invalidateCcBillingDetail(financing);
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
    const applied = applyFacturadoFinancingLinks()!;
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
    const again = applyFacturadoFinancingLinks()!;
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
      reason: "2 combinations of cuota purchases add up to the facturado",
    });
  });
});
