import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import {
  ccInstallmentInterestBillingEvents,
  ccInstallmentInterestForAccount,
  printedInstallmentRatePct,
} from "./ccInstallmentInterest.js";
import { listSchedulePurchaseEvents } from "./ccInstallmentLedgerDb.js";
import { ccFinancingCostClpByDate } from "./ccFinancingCostDaily.js";
import { buildCreditCardFinancingPlByBillingMonth } from "./creditCardPerformancePl.js";
import type { CcInstallmentPurchaseComputed } from "./creditCardInstallments.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

const TAG = "vitest-inst-interest";
let accountId = 0;
const planIds: Record<string, number> = {};

function insertPlan(key: string, date: string, total: number, count: number): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases
           (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
         VALUES (?, 'A', ?, ?, ?, ?, ?, 'pdf')`
      )
      .run(accountId, `${TAG}|${key}`, date, total, count, `${TAG} ${key}`).lastInsertRowid
  );
  planIds[key] = id;
  return id;
}

function insertCuotaLine(planId: number, key: string, statementDate: string, n: number, principal: number, cuota: number, rate: string): void {
  const st = Number(
    db
      .prepare(`INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency) VALUES (?, 'A', ?, ?, 'clp')`)
      .run(accountId, `${TAG}|${key}|${n}.pdf`, statementDate).lastInsertRowid
  );
  const rowId = `${TAG}|${key}|${n}`;
  db.prepare(
    `INSERT INTO cc_statement_lines
       (statement_id, transaction_date, merchant, amount_clp, valor_cuota_mensual_clp, nro_cuota_current,
        nro_cuota_total, interest_rate_text, parser_row_id)
     VALUES (?, '08/11/2036', ?, ?, ?, ?, 3, ?, ?)`
  ).run(st, `${TAG} ${key}`, principal, cuota, n, rate, rowId);
  db.prepare(
    `INSERT INTO cc_installment_payments
       (purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id, statement_date, statement_period_month)
     VALUES (?, ?, ?, ?, 3, ?, ?, ?)`
  ).run(planId, `2037-0${n}-10`, cuota, n, rowId, statementDate, `${statementDate.slice(6, 10)}-${statementDate.slice(3, 5)}`);
}

function cleanup(): void {
  db.prepare(`DELETE FROM cc_installment_payments WHERE parser_row_id LIKE ?`).run(`${TAG}|%`);
  db.prepare(`DELETE FROM cc_installment_purchases WHERE canonical_row_id LIKE ?`).run(`${TAG}|%`);
  db.prepare(`DELETE FROM cc_statements WHERE source_pdf LIKE ?`).run(`${TAG}|%`);
  if (accountId) invalidateCcBillingDetail(accountId);
}

describe("installment interest", () => {
  beforeAll(() => {
    accountId = getVitestSantanderCcMasterAccountId() ?? 0;
    if (!accountId) return;
    cleanup();
    // 3,09 %: principal 2xx.xxx, cuotas 1xx.xxx + 1xx.xxx + 1xx.xxx = 3xx.xxx → interest 2x.xxx.
    const rated = insertPlan("rated", "2036-11-08", 323_698, 3);
    insertCuotaLine(rated, "rated", "22/12/2036", 1, 295_141, 107_900, "3,09 %");
    insertCuotaLine(rated, "rated", "24/01/2037", 2, 295_141, 107_900, "3,09 %");
    // 0 %: the cuotas round 7 pesos above the principal — not interest.
    const free = insertPlan("free", "2036-11-09", 101_394, 3);
    insertCuotaLine(free, "free", "22/12/2036", 1, 101_387, 33_798, "0,00% (T)");
    // No statement yet (hand-entered or from the feed): no interest known.
    insertPlan("unprinted", "2036-11-10", 500_000, 3);
    invalidateCcBillingDetail(accountId);
  });

  afterAll(cleanup);

  it("reads the printed rate", () => {
    expect(printedInstallmentRatePct("3,09 %")).toBe(3.09);
    expect(printedInstallmentRatePct("0,00% (T)")).toBe(0);
    expect(printedInstallmentRatePct("0,00")).toBe(0);
    expect(() => printedInstallmentRatePct("n/a")).toThrow(/unreadable/);
  });

  it("is total − printed principal, only for a plan printed with a positive rate", () => {
    if (!accountId) return;
    const mine = ccInstallmentInterestForAccount(accountId).filter((p) => Object.values(planIds).includes(p.purchase_id));
    expect(mine).toEqual([
      {
        purchase_id: planIds.rated,
        iso: "2036-11-08",
        principal_clp: 295_141,
        total_clp: 323_698,
        interest_clp: 28_557,
        rate_text: "3,09 %",
      },
    ]);
  });

  it("enters the cuota line as principal at purchase and each billed cuota's share of the interest at its close", () => {
    if (!accountId) return;
    const mine = (e: { iso: string }) => e.iso.startsWith("2036") || e.iso.startsWith("2037");
    const purchases = listSchedulePurchaseEvents(accountId).filter(mine);
    expect(purchases).toContainEqual({ iso: "2036-11-08", clp: 295_141 });
    expect(purchases).not.toContainEqual({ iso: "2036-11-08", clp: 323_698 });
    // 2x.xxx over 3 cuotas: 9.519 + 9.519 + 9.519; cuotas 1 and 2 at their printed closes.
    const interest = ccInstallmentInterestBillingEvents(accountId).filter(mine);
    expect(interest.slice(0, 2)).toEqual([
      { iso: "2036-12-22", clp: 9_519 },
      { iso: "2037-01-24", clp: 9_519 },
    ]);
    expect(interest.reduce((t, e) => t + e.clp, 0)).toBe(28_557);
  });

  it("is the card's financing cost on the purchase date, and in the dashboard's billing month", () => {
    if (!accountId) return;
    expect(ccFinancingCostClpByDate(accountId).get("2036-11-08")).toBe(28_557);
    expect(ccFinancingCostClpByDate(accountId).get("2036-11-09")).toBeUndefined();

    const purchase = (key: string, billingMonth: string): CcInstallmentPurchaseComputed => ({
      purchase_id: `${TAG}|${key}`,
      purchase_db_id: planIds[key],
      purchase_billing_month: billingMonth,
      label: key,
      principal_clp: 0,
      installment_count: 3,
      installments_paid: 3,
      cuota_clp: 0,
      annual_interest_pct: 0,
      first_due_month: "2036-12",
      schedule_offset_months: 0,
      purchase_month: "2036-11",
      note: null,
      remaining_installments: 0,
      remaining_principal_clp: 0,
      next_due_month: null,
      next_installment_index: null,
      last_paid_month: "2037-02",
      upcoming_cuota_clp: 0,
      origin: "import_document",
    });
    const rows = buildCreditCardFinancingPlByBillingMonth(accountId, [purchase("rated", "2036-11"), purchase("free", "2036-11")]);
    expect(rows.find((r) => r.billing_month === "2036-11")?.installment_interest_clp).toBe(28_557);
    expect(rows.find((r) => r.billing_month === "2036-12")?.installment_interest_clp).toBe(0);
  });
});
