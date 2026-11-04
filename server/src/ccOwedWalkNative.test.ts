import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import {
  ccOwedByCurrencyAtYmd,
  ccOwedClpAtYmd,
  ccRevaluationCostByDate,
  ccUsdOwedRateClp,
  ccUsdRevaluationCostClpByDate,
} from "./ccOwedWalk.js";
import { convertValue } from "./valueConvert.js";
import { writeCcOwedAnchor } from "./ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { latestCreditCardValuationRowAsOf } from "./valuationLatest.js";

/**
 * A card owes a peso and a dollar sub-balance (docs/holdings-cards-plan.md): the walk keeps each in
 * its own currency, the value converts the dollars at the date's rate, and the day-to-day move of
 * that rate on the dollars carried over is the card's fx P/L.
 */

const TODAY = chileCalendarTodayYmd();
function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

const ANCHOR = addDaysIso(TODAY, -40);
const USD_CHARGE_DATE = addDaysIso(TODAY, -30);
const CLP_CHARGE_DATE = addDaysIso(TODAY, -20);
const END = addDaysIso(TODAY, -1);

let ccId: number | null = null;
let payCardId: number | null = null;
let payMovementId: number | null = null;
const statementIds: number[] = [];
const PAY_DATE = addDaysIso(TODAY, -15);
/** The pesos the divisas purchase actually cost for the US$100 payment. */
const PAID_CLP = 91_234;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;
  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · native owed card', 'vitest-native-owed', 'credit_card_master|santander|vitest-native-owed')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7778', 21, 20, 'santander')`
  ).run(ccId);
  const stmtDate = ddmmyyyy(addDaysIso(TODAY, -10));
  for (const currency of ["clp", "usd"] as const) {
    statementIds.push(
      Number(
        db
          .prepare(
            `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
             VALUES (?, 'santander', ?, ?, ?, ?, ?)`
          )
          .run(ccId, `vitest-native-owed-${currency}.pdf`, stmtDate, ddmmyyyy(addDaysIso(TODAY, -40)), stmtDate, currency)
          .lastInsertRowid
      )
    );
  }
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key)
     VALUES (?, ?, 'TIENDA VITEST', 0, 50, 0, 'vitest-native-owed-usd')`
  ).run(statementIds[1], ddmmyyyy(USD_CHARGE_DATE));
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, 'TIENDA VITEST', 30000, 0, 'vitest-native-owed-clp')`
  ).run(statementIds[0], ddmmyyyy(CLP_CHARGE_DATE));
  writeCcOwedAnchor(ccId, ANCHOR, { clp: 100_000, usd: 100 });

  // A second card: US$100 owed, paid on PAY_DATE by a divisas purchase whose pesos are on file.
  payCardId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · real-rate card', 'vitest-real-rate', 'credit_card_master|santander|vitest-real-rate')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7779', 21, 20, 'santander')`
  ).run(payCardId);
  const payStmt = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-real-rate-usd.pdf', ?, ?, ?, 'usd')`
      )
      .run(payCardId, stmtDate, ddmmyyyy(addDaysIso(TODAY, -40)), stmtDate)
      .lastInsertRowid
  );
  statementIds.push(payStmt);
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key)
     VALUES (?, ?, 'ABONO DE DIVISAS', 0, -100, 0, 'vitest-real-rate-abono')`
  ).run(payStmt, ddmmyyyy(PAY_DATE));
  const from = db
    .prepare(`SELECT id FROM accounts WHERE id NOT IN (?, ?) AND asset_group_id IS NOT NULL ORDER BY id LIMIT 1`)
    .get(ccId, payCardId) as { id: number };
  payMovementId = Number(
    db
      .prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
         VALUES (?, ?, ?, 'clp', 100, 'usd', ?, 'vitest real-rate divisas', 'pago_tarjeta')`
      )
      .run(from.id, payCardId, PAID_CLP, PAY_DATE).lastInsertRowid
  );
  writeCcOwedAnchor(payCardId, ANCHOR, { clp: 0, usd: 100 });
  clearAggregationCache();
});

afterAll(() => {
  for (const id of statementIds) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(id);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
  }
  if (payMovementId != null) db.prepare(`DELETE FROM movements WHERE id = ?`).run(payMovementId);
  for (const id of [ccId, payCardId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
  clearAggregationCache();
});

describe("per-currency owed walk", () => {
  it("keeps each currency apart and converts the dollars at the date's debt rate", () => {
    if (ccId == null) return;
    expect(ccOwedByCurrencyAtYmd(ccId, END)).toMatchObject({ clp: 130_000, usd: 150, as_of_date: ANCHOR });
    const rate = ccUsdOwedRateClp(150, END)!;
    expect(rate).toBeGreaterThan(0);
    expect(ccOwedClpAtYmd(ccId, END)?.value_clp).toBe(Math.round(130_000 + 150 * rate));
    // The account mark's card branch reads the whole walk at the date (nothing to add on top).
    expect(latestCreditCardValuationRowAsOf(ccId, END)).toEqual({
      value_clp: Math.round(130_000 + 150 * rate),
      as_of_date: END,
    });
  });

  it("the fx P/L plus the evidence at each day's rate is the change in value", () => {
    if (ccId == null) return;
    const cost = ccUsdRevaluationCostClpByDate(ccId);
    let sumCost = 0;
    for (const [d, c] of cost) if (d > ANCHOR && d <= END) sumCost += c;
    const v0 = 100 * ccUsdOwedRateClp(100, ANCHOR)!;
    const v1 = 150 * ccUsdOwedRateClp(150, END)!;
    const evidence = 50 * ccUsdOwedRateClp(150, USD_CHARGE_DATE)!;
    expect(sumCost + evidence).toBeCloseTo(v1 - v0, 6);
  });

  it("in dollars, the pesos owed are what revalues: cost plus evidence is the change in dollars", () => {
    if (ccId == null) return;
    const r = (d: string) => convertValue(1, "clp", "usd", d, "debt")!;
    let sumCost = 0;
    for (const [d, c] of ccRevaluationCostByDate(ccId, "usd")) if (d > ANCHOR && d <= END) sumCost += c;
    const v0 = 100_000 * r(ANCHOR) + 100;
    const v1 = 130_000 * r(END) + 150;
    const evidence = 30_000 * r(CLP_CHARGE_DATE) + 50;
    expect(sumCost + evidence).toBeCloseTo(v1 - v0, 9);
  });

  it("a dollar payment with its divisas purchase on file counts at the pesos paid", () => {
    if (payCardId == null) return;
    const cost = ccUsdRevaluationCostClpByDate(payCardId);
    const before = addDaysIso(PAY_DATE, -1);
    // The paid dollars' fx P/L that day: from the previous day's debt rate to the real rate.
    expect(cost.get(PAY_DATE)).toBeCloseTo(PAID_CLP - 100 * ccUsdOwedRateClp(100, before)!, 6);
    // Nothing is owed afterwards, so nothing revalues.
    for (const [d] of cost) expect(d <= PAY_DATE).toBe(true);
    // The whole currency P/L of the debt is the pesos paid less its pesos at the anchor.
    let sum = 0;
    for (const [d, c] of cost) if (d > ANCHOR) sum += c;
    expect(sum).toBeCloseTo(PAID_CLP - 100 * ccUsdOwedRateClp(100, ANCHOR)!, 6);
    // The payment day's derived flow (−Δvalue + cost) is the pesos paid.
    const vBefore = ccOwedClpAtYmd(payCardId, before)!.value_clp;
    const vPay = ccOwedClpAtYmd(payCardId, PAY_DATE)!.value_clp;
    expect(-(vPay - vBefore) + cost.get(PAY_DATE)!).toBeCloseTo(PAID_CLP, 0);
  });
});
