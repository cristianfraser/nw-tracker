import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { clearAggregationCache, invalidateCcBillingDetail } from "./aggregationCache.js";
import { db } from "./db.js";

/**
 * CC per-day owed-on-date: between stored month-end anchors, the mark carries the anchor
 * plus post-anchor signed statement-line activity (charges +, PAGOs −) dated by
 * transaction_date — the same evidence stream the month-end writer applies post-cierre.
 * Synthetic fixture (own master, no installment ledger): anchor 500.000 at 2026-03-31,
 * purchase +120.000 on 04-10, PAGO −500.000 on 04-15.
 */

let leafSlug: string | null = null;
let accountId: number | null = null;
let statementId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(
      `SELECT id, slug FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`
    )
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · daily owed cc', 'vitest-daily-owed-cc', 'vitest-daily-owed-cc', 'master')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2026-03-31', 500000, 'clp')`
  ).run(accountId);

  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
         VALUES (?, 'santander', 'vitest-daily-owed.pdf', '23/04/2026', '25/03/2026', '23/04/2026')`
      )
      .run(accountId).lastInsertRowid
  );
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  insLine.run(statementId, "10/04/2026", "VITEST STORE", 120000, "vitest-daily-owed-1");
  insLine.run(statementId, "15/04/2026", "PAGO WEB", -500000, "vitest-daily-owed-2");

  clearAggregationCache();
});

afterAll(() => {
  if (statementId != null) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  }
  if (accountId != null) {
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  }
  clearAggregationCache();
});

function markAt(ymd: string): number | null {
  if (accountId == null || leafSlug == null) return null;
  return accountMarkClpAtYmd(accountId, ymd, leafSlug)?.value_clp ?? null;
}

describe("CC per-day owed-on-date", () => {
  it("carries the anchor until activity lands, then steps on transaction days", () => {
    if (accountId == null) return;
    expect(markAt("2026-04-05")).toBe(500000); // anchor forward-filled, empty window
    expect(markAt("2026-04-10")).toBe(620000); // + purchase on its transaction day
    expect(markAt("2026-04-12")).toBe(620000); // flat between events
    expect(markAt("2026-04-16")).toBe(120000); // − PAGO on its day
  });

  it("anchor-dated mark stays the stored value (no carry window)", () => {
    if (accountId == null) return;
    expect(markAt("2026-03-31")).toBe(500000);
  });

  it("per-account invalidation drops the memoized line stream", () => {
    if (accountId == null || statementId == null) return;
    // Warm the memo, then add a line the memo doesn't know about.
    expect(markAt("2026-04-18")).toBe(120000);
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
       VALUES (?, '18/04/2026', 'VITEST STORE 2', 50000, 0, 'vitest-daily-owed-3')`
    ).run(statementId);
    invalidateCcBillingDetail(accountId);
    expect(markAt("2026-04-18")).toBe(170000);
  });
});
