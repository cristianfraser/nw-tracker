import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_CARD_STATEMENT_HEADER, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { applyCanonicalCardStatements } from "./ccParsedStatementsApply.js";
import type { CcStatementRow } from "./ccStatementsDb.js";
import { closedBillingMonthsFromStatements, sameMonthStatementConflicts } from "./cards/facturacion.js";
import { db } from "./db.js";
import { wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

/**
 * A facturación is one statement per currency: two DIFFERENT statements of one currency whose
 * closes fall in the same billing month (calendar month of `period_to`) are refused — by the merge
 * import, inside its transaction, and by the close rule on read — instead of merging into one row.
 * Copies of one statement (same close) are not a conflict.
 */

const IMPORT_KEY = "credit_card_master|euronova|vitest-same-month";
const LAST4 = "4405";
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Both closes in March 2025: the 1st and the 31st.
const CLOSE_EARLY = "2025-03-01";
const CLOSE_LATE = "2025-03-31";
const SAME_MONTH = /two different statements of one currency close in the same billing month — 2025-03 eur/;

function statement(close: string, amount: number): CardCanonicalStatement {
  const line = {
    kind: "card_purchase",
    transaction_date: addDays(close, -5),
    posting_date: null,
    printed_transaction_date: ddmm(addDays(close, -5)),
    printed_posting_date: null,
    merchant: `VITEST SAME MONTH ${close}`,
    description: `VITEST SAME MONTH ${close}`,
    place: null,
    country: null,
    currency: "eur",
    amount,
    origin_amount: null,
    installment: null,
    origin_card_last4: null,
    cuota_purchase: null,
    document: {
      line_id: `vitest-same-month|${close}`,
      dedupe_key: `vitest-same-month|${close}`,
      section: "international_usd",
      raw_text: `${ddmm(addDays(close, -5))} VITEST`,
      duplicate_across_statements: false,
      baseline_match: null,
    },
  } as CardCanonicalLine;
  return {
    document: `vitest-same-month-${close}.pdf`,
    card_group: "EURONOVA",
    close: ddmm(close),
    period_from: ddmm(addDays(close, -29)),
    period_to: ddmm(close),
    pay_by: ddmm(addDays(close, 25)),
    card_last4: LAST4,
    card_product: "Euronova Classic",
    currency: "eur",
    layout: "international_usd",
    header: {
      ...EMPTY_CARD_STATEMENT_HEADER,
      saldo_anterior: 0,
      abono: 0,
      compras_cargos: amount,
      monto_facturado: amount,
      deuda_total: amount,
      next_period_from: ddmm(addDays(close, 1)),
      next_period_to: ddmm(addDays(close, 30)),
    },
    lines: [line],
  };
}

const statementCount = () =>
  (db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(cardId) as { c: number }).c;

let cardId = 0;

beforeAll(() => {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
    .get() as { id: number };
  cardId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · same-month statements', ?, ?)`)
      .run(bucket.id, IMPORT_KEY, IMPORT_KEY).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
     VALUES (?, 1, 28, ?, 'euronova')`
  ).run(cardId, LAST4);
});

afterAll(() => {
  wipeVitestCcFixtureData(IMPORT_KEY);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
  clearAggregationCache();
});

function row(id: number, close: string, currency: string, source_kind = "statement_pdf"): CcStatementRow {
  return {
    id,
    account_id: 1,
    source_pdf: `doc-${id}.pdf`,
    source_kind,
    statement_date: ddmm(close),
    period_to: ddmm(close),
    currency,
    billing_month: close.slice(0, 7),
  } as CcStatementRow;
}

describe("two different statements of one currency in one billing month", () => {
  it("are a conflict; copies of one close, other currencies and listings are not", () => {
    expect(sameMonthStatementConflicts([row(1, CLOSE_EARLY, "clp"), row(2, CLOSE_EARLY, "clp")])).toEqual([]);
    expect(sameMonthStatementConflicts([row(1, CLOSE_EARLY, "clp"), row(2, CLOSE_LATE, "usd")])).toEqual([]);
    expect(
      sameMonthStatementConflicts([row(1, CLOSE_EARLY, "clp"), row(2, CLOSE_LATE, "clp", "listing_open")])
    ).toEqual([]);
    expect(sameMonthStatementConflicts([row(1, CLOSE_LATE, "clp"), row(2, CLOSE_EARLY, "clp")])).toEqual([
      {
        billing_month: "2025-03",
        currency: "clp",
        statements: [
          { id: 2, source_pdf: "doc-2.pdf", close_iso: CLOSE_EARLY },
          { id: 1, source_pdf: "doc-1.pdf", close_iso: CLOSE_LATE },
        ],
      },
    ]);
    expect(() =>
      closedBillingMonthsFromStatements([row(1, CLOSE_EARLY, "clp"), row(2, CLOSE_LATE, "clp")], "clp", new Set(["clp"]), null)
    ).toThrow(/Account 1: two different statements of one currency close in the same billing month — 2025-03 clp/);
  });

  it("are refused by the import in one batch, writing nothing", () => {
    expect(() =>
      applyCanonicalCardStatements([statement(CLOSE_EARLY, 100), statement(CLOSE_LATE, 200)], { dryRun: false, full: true })
    ).toThrow(SAME_MONTH);
    expect(statementCount()).toBe(0);
  });

  it("are refused when the second arrives later, leaving the first in place", () => {
    const first = applyCanonicalCardStatements([statement(CLOSE_EARLY, 100)], { dryRun: false, full: true });
    expect(first.problems).toEqual([]);
    expect(first.applied).toBe(true);
    expect(statementCount()).toBe(1);
    clearAggregationCache();
    expect(() => applyCanonicalCardStatements([statement(CLOSE_LATE, 200)], { dryRun: false, full: false })).toThrow(
      SAME_MONTH
    );
    expect(statementCount()).toBe(1);
  });
});
