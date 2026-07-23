import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { ccOwedWalkClpAtYmd } from "./ccOwedWalk.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { latestCreditCardDisplayedBalance } from "./valuationLatest.js";

/**
 * Today is valued the same way as every other day: last anchor + evidence dated after it.
 * It used to come from the live billing formula (facturado + cupo en cuotas − cuota a pagar
 * next mes), a different framing of the same debt — so the gap between the two frames landed
 * in today's delta and a day with no transactions still moved.
 */

const TODAY = chileCalendarTodayYmd();

function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const ANCHOR_DATE = addDaysIso(TODAY, -6);
const ANCHOR_VALUE = 400_000;
const CHARGE_DATE = addDaysIso(TODAY, -3);
const CHARGE = 25_000;

let ccId: number | null = null;
let statementId: number | null = null;
let purchaseId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(
      `SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!leaf) return;

  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · owed walk card', 'vitest-owed-walk', 'vitest-owed-walk', 'master')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, '7777', 21, 20)`
  ).run(ccId);

  const stmtDate = addDaysIso(TODAY, -20);
  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-owed-walk.pdf', ?, ?, ?, 'clp')`
      )
      .run(ccId, stmtDate, addDaysIso(stmtDate, -30), stmtDate).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, 'TIENDA VITEST', ?, 0, 'vitest-owed-walk-buy')`
  ).run(statementId, CHARGE_DATE, CHARGE);
  // An installment ledger row is what puts a card on the live-billing path at all.
  purchaseId = Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases
           (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
         VALUES (?, 'santander', 'vitest-owed-walk-plan', ?, 60000, 6, 'PLAN VITEST', 'manual')`
      )
      .run(ccId, addDaysIso(TODAY, -60)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  ).run(ccId, ANCHOR_DATE, ANCHOR_VALUE);
  clearAggregationCache();
});

afterAll(() => {
  if (purchaseId != null) {
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(purchaseId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(purchaseId);
  }
  if (statementId != null) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  }
  if (ccId != null) {
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  }
  clearAggregationCache();
});

describe("ccOwedWalkClpAtYmd", () => {
  it("walks from the anchor strictly before the date, so a same-date stamp is not circular", () => {
    if (ccId == null) return;
    const walked = ccOwedWalkClpAtYmd(ccId, TODAY);
    expect(walked?.value_clp).toBe(ANCHOR_VALUE + CHARGE);
    expect(walked?.as_of_date).toBe(ANCHOR_DATE);

    // Writing a stamp for today must not change what the walk computes for today.
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, 999999, 'clp')
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value`
    ).run(ccId, TODAY);
    expect(ccOwedWalkClpAtYmd(ccId, TODAY)?.value_clp).toBe(ANCHOR_VALUE + CHARGE);
    db.prepare(`DELETE FROM valuations WHERE account_id = ? AND as_of_date = ?`).run(ccId, TODAY);
    clearAggregationCache();
  });
});

describe("latestCreditCardDisplayedBalance — today", () => {
  it("is the walked balance, not the live billing formula", () => {
    if (ccId == null) return;
    const shown = latestCreditCardDisplayedBalance(ccId, TODAY);
    expect(shown?.value_clp).toBe(ANCHOR_VALUE + CHARGE);
    // `as_of_date` is the walked-through date, so callers never re-apply the window on top.
    expect(shown?.as_of_date).toBe(TODAY);
  });

  it("the account mark does not move on a day with no evidence dated that day", () => {
    if (ccId == null) return;
    // The series values every day through `accountMarkClpAtYmd`: yesterday takes the
    // historical branch (anchor + window), today the live stack. Both now walk, so with the
    // newest evidence dated 3 days ago the two are equal and the day reads 0.
    const yesterday = accountMarkClpAtYmd(ccId, addDaysIso(TODAY, -1));
    const today = accountMarkClpAtYmd(ccId, TODAY);
    expect(yesterday?.value_clp).toBe(ANCHOR_VALUE + CHARGE);
    expect(today!.value_clp - yesterday!.value_clp).toBe(0);
  });
});
