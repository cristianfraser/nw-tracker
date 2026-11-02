import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import {
  ccOwedByCurrencyAtYmd,
  ccOwedClpAtYmd,
  ccUsdOwedRateClp,
  ccUsdRevaluationCostClpByDate,
} from "./ccOwedWalk.js";
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
const statementIds: number[] = [];

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
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, '7778', 21, 20)`
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
  clearAggregationCache();
});

afterAll(() => {
  for (const id of statementIds) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(id);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
  }
  if (ccId != null) {
    db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
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
});
