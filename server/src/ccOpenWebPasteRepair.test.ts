import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { db } from "./db.js";
import {
  openWebPasteSourcePdf,
  parseOpenWebPasteBillingMonth,
  repairMisplacedOpenWebPasteBuckets,
} from "./ccOpenWebPasteRepair.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

describe("repairMisplacedOpenWebPasteBuckets", () => {
  let accountId = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T15:00:00Z")); // June open; May closed by its statement
    accountId = createTempCardMaster({ issuer: "santander", last4: "4242", key: "vitest-open-bucket-repair" });
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency
       ) VALUES (?, 'santander', 'vitest 2026-05-20 clp.pdf', '20/05/2026', '21/04/2026', '20/05/2026', '4242', 'compact', 'clp')`
    ).run(accountId);
  });

  afterEach(() => {
    vi.useRealTimers();
    deleteTempCardMaster(accountId);
  });

  function insertBucketLine(statementId: number, ddMmYyyy: string, merchant: string): number {
    const dedupe = `vitest-repair-${merchant}-${ddMmYyyy}`;
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line
           ) VALUES (?, ?, ?, 5000, 0, ?, ?, 'raw')`
        )
        .run(statementId, ddMmYyyy, merchant, dedupe, dedupe).lastInsertRowid
    );
  }

  function bucketMonthOfLine(lineId: number): string | null {
    const row = db
      .prepare(
        `SELECT s.source_pdf FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`
      )
      .get(lineId) as { source_pdf: string };
    return parseOpenWebPasteBillingMonth(row.source_pdf);
  }

  it("moves post-close web-paste lines from stale open bucket to current open month", () => {
    const stale = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, card_last4, layout, currency
           ) VALUES (?, 'santander', ?, '20/05/2026', '4242', 'compact', 'clp')`
        )
        .run(accountId, openWebPasteSourcePdf("2026-05")).lastInsertRowid
    );
    const preClose = insertBucketLine(stale, "15/05/2026", "ACME STORE");
    // Santander's next cycle starts ON the close day: the 20th already bills in June.
    const closeDay = insertBucketLine(stale, "20/05/2026", "ACME CAFE");
    const postClose = insertBucketLine(stale, "23/05/2026", "ACME TAXI");

    const repaired = repairMisplacedOpenWebPasteBuckets(accountId);
    expect(repaired).toEqual({ lines_moved: 2, target_billing_month: "2026-06" });
    expect(bucketMonthOfLine(preClose)).toBe("2026-05");
    expect(bucketMonthOfLine(closeDay)).toBe("2026-06");
    expect(bucketMonthOfLine(postClose)).toBe("2026-06");
    // Nothing left to move on a second pass.
    expect(repairMisplacedOpenWebPasteBuckets(accountId).lines_moved).toBe(0);
  });
});
