import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { insertLines } from "./cards/lineWrites.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { InputError } from "./inputError.js";
import { listAnnulledPurchases } from "./ccAnnulledPurchases.js";
import {
  AnnulmentConflictError,
  markAnnulledPurchaseManually,
  undoManualAnnulledPurchase,
} from "./ccAnnulledPurchaseManual.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

describe("manual annulled purchases", () => {
  let accountId = 0;
  const today = chileCalendarTodayYmd();

  function list(merchant: string, amount: number, date = today, n = 1): void {
    insertLines(accountId, {
      lines: Array.from({ length: n }, () => ({
        transaction_date: date,
        merchant,
        currency: "clp" as const,
        amount,
        raw_line: merchant,
      })),
      errors: [],
    });
  }

  function lineIds(merchant: string): number[] {
    return (
      db
        .prepare(
          `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
           WHERE s.account_id = ? AND l.merchant = ? ORDER BY l.id`
        )
        .all(accountId, merchant) as { id: number }[]
    ).map((r) => r.id);
  }

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "7711", key: "vitest-annul-manual" });
  });
  afterEach(() => deleteTempCardMaster(accountId));

  it("marks a bucket charge: row written, line gone", () => {
    list("VITEST ANNUL SHOP", 15_000);
    const [id] = lineIds("VITEST ANNUL SHOP");
    const key = resolveCcExpensePurchaseKey(id!);
    const a = markAnnulledPurchaseManually(accountId, id!, today);
    expect(a.basis).toBe("manual");
    expect(a.evidence).toBeNull();
    expect(a.purchase_key).toBe(key);
    expect(listAnnulledPurchases(accountId)).toHaveLength(1);
    expect(lineIds("VITEST ANNUL SHOP")).toHaveLength(0);
  });

  it("refuses dates out of range, other accounts' lines and non-bucket lines", () => {
    list("VITEST ANNUL SHOP", 15_000, "2026-11-01");
    const [id] = lineIds("VITEST ANNUL SHOP");
    expect(() => markAnnulledPurchaseManually(accountId, id!, "2026-10-31")).toThrow(InputError);
    expect(() => markAnnulledPurchaseManually(accountId, id!, "2999-01-01")).toThrow(InputError);
    expect(() => markAnnulledPurchaseManually(accountId, id!, "11/05/2026")).toThrow(InputError);
    expect(() => markAnnulledPurchaseManually(accountId + 999_999, id!, today)).toThrow(InputError);
    expect(() => markAnnulledPurchaseManually(accountId, 999_999_999, today)).toThrow(InputError);
    // A credit is not a charge.
    list("VITEST ANNUL CREDIT", -5_000);
    const [credit] = lineIds("VITEST ANNUL CREDIT");
    if (credit) expect(() => markAnnulledPurchaseManually(accountId, credit, today)).toThrow(InputError);
    // A line of a closed statement is not in a listing bucket.
    const st = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', 'vitest annul closed.pdf', '25/08/2026', '7711', 'compact', 'clp')`
        )
        .run(accountId).lastInsertRowid
    );
    const pdfLine = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
           VALUES (?, '2026-08-01', 'VITEST CLOSED', 1000, 0, 'vitest-annul-closed')`
        )
        .run(st).lastInsertRowid
    );
    expect(() => markAnnulledPurchaseManually(accountId, pdfLine, today)).toThrow(/open listing/);
    expect(listAnnulledPurchases(accountId)).toHaveLength(0);
  });

  it("undo puts the purchase back under the same expense key", () => {
    list("VITEST ANNUL SHOP", 15_000);
    const [id] = lineIds("VITEST ANNUL SHOP");
    const key = resolveCcExpensePurchaseKey(id!);
    const a = markAnnulledPurchaseManually(accountId, id!, today);
    undoManualAnnulledPurchase(accountId, a.id);
    expect(listAnnulledPurchases(accountId)).toHaveLength(0);
    const back = lineIds("VITEST ANNUL SHOP");
    expect(back).toHaveLength(1);
    // The flow (category, note, big group hang off it) is the one the purchase had.
    const flowOf = (lineId: number) =>
      (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(lineId) as { flow_id: number | null }).flow_id;
    expect(a.flow_id).not.toBeNull();
    expect(flowOf(back[0]!)).toBe(a.flow_id);
    expect(resolveCcExpensePurchaseKey(back[0]!)).toBe(key);
  });

  it("undo of a twin re-lists only the missing copy", () => {
    list("VITEST ANNUL TWIN", 9_000, today, 2);
    const [first, second] = lineIds("VITEST ANNUL TWIN");
    const key2 = resolveCcExpensePurchaseKey(second!);
    const a = markAnnulledPurchaseManually(accountId, second!, today);
    expect(lineIds("VITEST ANNUL TWIN")).toEqual([first]);
    undoManualAnnulledPurchase(accountId, a.id);
    const after = lineIds("VITEST ANNUL TWIN");
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(first);
    expect(resolveCcExpensePurchaseKey(after[1]!)).toBe(key2);
  });

  it("refuses to undo an annulment the bank's evidence decided", () => {
    list("VITEST ANNUL SHOP", 15_000);
    const [id] = lineIds("VITEST ANNUL SHOP");
    const a = markAnnulledPurchaseManually(accountId, id!, today);
    db.prepare(`UPDATE cc_annulled_purchases SET basis = 'feed_drop', evidence = 'vitest.json' WHERE id = ?`).run(a.id);
    expect(() => undoManualAnnulledPurchase(accountId, a.id)).toThrow(AnnulmentConflictError);
    expect(listAnnulledPurchases(accountId)).toHaveLength(1);
    expect(lineIds("VITEST ANNUL SHOP")).toHaveLength(0);
  });
});
