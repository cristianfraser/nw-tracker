import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

/**
 * A card's daily balance follows its EVIDENCE dates; when the evidence was imported is not
 * part of the model. The daily "today" stamps freeze the live formula on the day they are
 * written, so evidence imported later for an earlier day contradicts them — the owed walk
 * would climb through the new purchases and then snap back to the stale stamp, dumping the
 * whole import into "today's" delta. Those stamps must be purged; the statement-derived
 * month-end anchors must survive (this same run recomputes them).
 */

const TODAY = chileCalendarTodayYmd();

function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Last day of the month two months back — a month-end anchor safely before any fixture stamp. */
function monthEndTwoMonthsBack(): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 0)).toISOString().slice(0, 10);
}

const MONTH_END = monthEndTwoMonthsBack();
const STALE_STAMP = addDaysIso(TODAY, -2);
const OLDER_STAMP = addDaysIso(TODAY, -9);
const EVIDENCE_DATE = addDaysIso(TODAY, -5);

let ccId: number | null = null;
let statementId: number | null = null;

function stampDates(): string[] {
  return (
    db
      .prepare(`SELECT as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
      .all(ccId) as { as_of_date: string }[]
  ).map((r) => r.as_of_date);
}

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
         VALUES (?, 'Vitest · stamp purge card', 'vitest-stamp-purge', 'vitest-stamp-purge', 'master')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, '8888', 21, 20)`
  ).run(ccId);
  // A statement gives the account a ledger, so the writer has month-end points to emit.
  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-stamp-purge.pdf', ?, ?, ?, 'clp')`
      )
      .run(ccId, MONTH_END, addDaysIso(MONTH_END, -30), MONTH_END).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, 'TIENDA VITEST', 50000, 0, 'vitest-stamp-purge-1')`
  ).run(statementId, addDaysIso(MONTH_END, -3));
  clearAggregationCache();
});

afterAll(() => {
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

function seedStamps(): void {
  if (ccId == null) return;
  const ins = db.prepare(
    `INSERT OR REPLACE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  ins.run(ccId, MONTH_END, 111_111);
  ins.run(ccId, OLDER_STAMP, 222_222);
  ins.run(ccId, STALE_STAMP, 333_333);
  clearAggregationCache();
}

describe("upsertCreditCardValuationsFromLedger — contradicted daily stamps", () => {
  it("purges daily stamps dated after the new evidence, keeping earlier ones and month-ends", () => {
    if (ccId == null) return;
    seedStamps();
    upsertCreditCardValuationsFromLedger(ccId, { affectedEvidenceFromYmd: EVIDENCE_DATE });
    const dates = stampDates();
    // Written 2 days ago, contradicted by evidence dated 5 days ago → gone.
    expect(dates).not.toContain(STALE_STAMP);
    // Written 9 days ago, before the evidence → still valid.
    expect(dates).toContain(OLDER_STAMP);
    // Statement-derived anchor → always kept.
    expect(dates).toContain(MONTH_END);
    // Purging happens even when this run has no ledger points to write (removing wrong data
    // must not depend on having new data); the walk then carries from the month-end anchor.
    expect(dates).not.toContain(TODAY);
  });

  it("purges nothing without an affected date (plain recompute)", () => {
    if (ccId == null) return;
    seedStamps();
    upsertCreditCardValuationsFromLedger(ccId);
    const dates = stampDates();
    expect(dates).toContain(STALE_STAMP);
    expect(dates).toContain(OLDER_STAMP);
    expect(dates).toContain(MONTH_END);
  });

  it("is idempotent: re-running with the same date purges nothing new", () => {
    if (ccId == null) return;
    seedStamps();
    upsertCreditCardValuationsFromLedger(ccId, { affectedEvidenceFromYmd: EVIDENCE_DATE });
    const first = stampDates();
    upsertCreditCardValuationsFromLedger(ccId, { affectedEvidenceFromYmd: EVIDENCE_DATE });
    expect(stampDates()).toEqual(first);
  });
});
