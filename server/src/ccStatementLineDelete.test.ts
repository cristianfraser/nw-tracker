import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonths } from "nw-tracker-contracts";
import { snapshotTables } from "./test/snapshotTables.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { deleteCcWebPasteStatementLine } from "./ccStatementLineDelete.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

/**
 * On the isolated fixture card, its own open listing and its own printed statement (the generated
 * person's card has an open listing only on some days of its cycle): a listing line deletes, a
 * statement line is refused.
 */
describe("deleteCcWebPasteStatementLine", () => {
  let accountId = 0;
  const statementIds: number[] = [];

  beforeAll(() => {
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) throw new Error("the Vitest fixture card is missing");
    accountId = id;
    const today = chileCalendarTodayYmd();
    const ym = today.slice(0, 7);
    const ddmmyyyy = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
    const lastMonthClose = `${addCalendarMonths(ym, -1)}-20`;
    const insStatement = db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_to, currency)
       VALUES (?, 'santander', ?, ?, ?, 'clp')`
    );
    statementIds.push(
      Number(insStatement.run(accountId, `import:web-paste|open|${ym}`, ddmmyyyy(today), null).lastInsertRowid),
      Number(insStatement.run(accountId, "vitest-line-delete.pdf", ddmmyyyy(lastMonthClose), ddmmyyyy(lastMonthClose)).lastInsertRowid)
    );
  });

  afterAll(() => {
    for (const id of statementIds) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
    }
    restoreDerivedCardState();
  });

  const insertLine = (statementId: number, date: string, key: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
           VALUES (?, ?, 'VITEST LINE DELETE', 1234, 0, ?)`
        )
        .run(statementId, date, key).lastInsertRowid
    );

  it("deletes a web-paste line and rejects a statement's", () => {
    const [listingId, statementId] = statementIds as [number, number];
    const today = chileCalendarTodayYmd();
    const listingLine = insertLine(listingId, `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`, "vitest-line-delete-open");
    const lastMonth = addCalendarMonths(today.slice(0, 7), -1);
    const statementLine = insertLine(statementId, `10/${lastMonth.slice(5, 7)}/${lastMonth.slice(0, 4)}`, "vitest-line-delete-pdf");
    const count = (id: number) => (db.prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`).get(id) as { c: number }).c;

    const before = count(listingId);
    expect(deleteCcWebPasteStatementLine(accountId, listingLine).removed_count).toBe(1);
    expect(count(listingId)).toBe(before - 1);

    expect(() => deleteCcWebPasteStatementLine(accountId, statementLine)).toThrow(/web-paste/);
    expect(count(statementId)).toBe(1);
  });
});
