/**
 * The card P/L's identity (formerly `scripts/verify-cc-financing-identity.ts`): the section-3
 * charges the daily P/L takes from the owed walk's evidence stream (`ccSection3FinancingClpByDate`,
 * plus plan interest) add up to the charges the statements print, card by card. The statement side
 * is the oracle here, read straight from the statements of each facturación (dollars at the
 * facturación's debt rate), so the two sources cannot drift apart unnoticed.
 */
import { isClpSection3FinancingChargeMerchant, isUsdSection3FinancingChargeMerchant } from "nw-tracker-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { balanceUsdFxDateIso } from "./ccBillingBalances.js";
import { ccSection3FinancingClpByDate } from "./ccFinancingCostDaily.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { billingMonthContainingPurchase } from "./cards/facturacion.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { lineAmountClpSql } from "./cards/lineAmountSql.js";

/** The section-3 charges the statements of one facturación print, in pesos. */
function statementSection3ChargesClp(accountId: number, billingMonth: string): number {
  const dates = new Set(statementDatesForFacturacion(accountId, billingMonth));
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!dates.has(st.statement_date)) continue;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      if (st.currency === "usd") {
        const amt = line.amount_usd ?? 0;
        if (!isUsdSection3FinancingChargeMerchant(line.merchant, amt) || amt <= 0) continue;
        const fx = fxRowOnOrBefore(balanceUsdFxDateIso(accountId, st.statement_date));
        if (!fx || !(fx.clp_per_usd > 0)) throw new Error(`no USD/CLP rate for the ${st.statement_date} charges`);
        sum += Math.round(amt * fx.clp_per_usd);
      } else {
        const amt = line.amount_clp ?? 0;
        if (!isClpSection3FinancingChargeMerchant(line.merchant) || amt <= 0) continue;
        sum += amt;
      }
    }
  }
  return Math.round(sum);
}

function shiftMonth(bm: string, delta: number): string {
  const [y, m] = bm.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const restoreTables = snapshotTables(["cc_statement_lines"]);
/** A synthetic interest charge on a card's newest peso statement, so the identity is not 0 = 0. */
const CHARGE_CLP = 1234;
let chargedCard: number | null = null;

beforeAll(() => {
  const st = db
    .prepare(
      `SELECT s.id, s.account_id, l.transaction_date FROM cc_statements s
       JOIN cc_statement_lines l ON l.statement_id = s.id
       WHERE s.currency = 'clp' AND l.installment_flag = 0 AND ${lineAmountClpSql("l")} > 0
       ORDER BY s.statement_date DESC, l.id LIMIT 1`
    )
    .get() as { id: number; account_id: number; transaction_date: string } | undefined;
  if (!st) throw new Error("the test database has no peso card statement line");
  chargedCard = st.account_id;
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, raw_line)
     VALUES (?, ?, 'INTERESES ROTATIVO', ?, 0, 'test-financing-identity', 'test')`
  ).run(st.id, st.transaction_date, CHARGE_CLP);
});
afterAll(() => restoreTables());

describe("card financing identity", () => {
  it("every card's P/L charges equal its statements' section-3 charges plus plan interest", () => {
    const cards = listCreditCardMasterAccountIds();
    expect(cards).toContain(chargedCard);
    expect([...ccSection3FinancingClpByDate(chargedCard!).values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(CHARGE_CLP);
    for (const accountId of cards) {
      const byMonth = new Map<string, number>();
      for (const [iso, clp] of ccSection3FinancingClpByDate(accountId)) {
        const bm = billingMonthContainingPurchase(accountId, iso);
        byMonth.set(bm, (byMonth.get(bm) ?? 0) + clp);
      }
      // A charge posted on a cycle end can sit in the next billing month: compare the totals
      // over every month with a charge and its neighbours.
      const span = new Set<string>();
      for (const bm of byMonth.keys()) for (const d of [-1, 0, 1]) span.add(shiftMonth(bm, d));
      let derived = 0;
      let printed = 0;
      for (const bm of span) {
        derived += Math.round(byMonth.get(bm) ?? 0);
        printed += statementSection3ChargesClp(accountId, bm);
      }
      for (const plan of ccInstallmentInterestForAccount(accountId)) printed += plan.interest_clp;
      expect({ accountId, diff: derived - printed }).toEqual({ accountId, diff: 0 });
    }
  });
});
