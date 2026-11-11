import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_PARSED_STATEMENT_COLUMNS, type MortgagePaymentReceiptPayload } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { applyCanonicalCardStatements } from "./ccParsedStatementsApply.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { IngestConflict } from "./ingestReceiver.js";
import { LENDER_CARD_MERCHANT, applyMortgagePaymentReceipt } from "./mortgagePaymentReceiptsApply.js";
import { parsedStatements } from "./test/parsedStatementRecords.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

/** Synthetic BCI card and receipt: no real card digits, transaction ids or amounts. */
const CARD_LAST4 = "4747";
const TODAY = chileCalendarTodayYmd();
function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
const PAID_ON = addDaysIso(TODAY, -15);
const CLOSE = addDaysIso(TODAY, -5);

function receipt(partial: Partial<MortgagePaymentReceiptPayload> = {}): MortgagePaymentReceiptPayload {
  return {
    lender: "metlife",
    transaction_id: "VITEST-TX-0001",
    paid_on: PAID_ON,
    amount_clp: 432_101,
    credit_number: "VITEST-CREDIT-1",
    dividend_number: "7",
    due_on: PAID_ON,
    card_last4: CARD_LAST4,
    ...partial,
  };
}

let cardId = 0;

function cardLines(): { id: number; merchant: string; amount_clp: number; source_pdf: string }[] {
  return db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, s.source_pdf FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`
    )
    .all(cardId) as { id: number; merchant: string; amount_clp: number; source_pdf: string }[];
}

beforeAll(() => {
  cardId = createTempCardMaster({ issuer: "bci", last4: CARD_LAST4, key: "vitest-mortgage-receipt" });
});

afterAll(() => {
  db.prepare(`DELETE FROM mortgage_payment_receipts WHERE card_account_id = ?`).run(cardId);
  deleteTempCardMaster(cardId);
  clearAggregationCache();
});

describe("applyMortgagePaymentReceipt", () => {
  it("stores the receipt and plants the charge on the card's open bucket", () => {
    const details = applyMortgagePaymentReceipt(receipt(), "<vitest-msg-1@example.test>");
    expect(details.card_account_id).toBe(cardId);
    expect(details.card_line).toBe("planted");
    const stored = db.prepare(`SELECT * FROM mortgage_payment_receipts WHERE id = ?`).get(details.receipt_id) as {
      amount_clp: number;
      message_id: string;
    };
    expect(stored.amount_clp).toBe(432_101);
    expect(stored.message_id).toBe("<vitest-msg-1@example.test>");
    const lines = cardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.merchant).toBe(LENDER_CARD_MERCHANT.metlife);
    expect(lines[0]!.amount_clp).toBe(432_101);
    expect(lines[0]!.source_pdf).toMatch(/^import:web-paste/);
  });

  it("is idempotent: the same receipt again changes nothing", () => {
    const again = applyMortgagePaymentReceipt(receipt(), "<vitest-msg-2@example.test>");
    expect(again.card_line).toBe("on_file");
    expect(cardLines()).toHaveLength(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM mortgage_payment_receipts WHERE card_account_id = ?`).get(cardId) as { n: number }).n
    ).toBe(1);
  });

  it("a resend stating other fields is a conflict and writes nothing", () => {
    expect(() => applyMortgagePaymentReceipt(receipt({ amount_clp: 432_102 }), "<vitest-msg-3@example.test>")).toThrow(
      IngestConflict
    );
    expect(cardLines()).toHaveLength(1);
  });

  it("an unknown card or lender throws", () => {
    expect(() => applyMortgagePaymentReceipt(receipt({ transaction_id: "VITEST-TX-X", card_last4: "4748" }), "m")).toThrow(
      /no card account/
    );
    expect(() => applyMortgagePaymentReceipt(receipt({ transaction_id: "VITEST-TX-Y", lender: "otherbank" }), "m")).toThrow(
      /no card merchant/
    );
  });

  it("the card's statement printing the charge settles the planted line", () => {
    const merchant = `${LENDER_CARD_MERCHANT.metlife} (T)`;
    const record = {
      ...Object.fromEntries(CARD_PARSED_STATEMENT_COLUMNS.map((c) => [c, ""])),
      card_group: "A",
      source_pdf: `vitest-mortgage-receipt-${CLOSE}.pdf`,
      statement_date: ddmmyyyy(CLOSE),
      period_from: ddmmyyyy(addDaysIso(CLOSE, -30)),
      period_to: ddmmyyyy(CLOSE),
      pay_by: ddmmyyyy(addDaysIso(CLOSE, 15)),
      card_last4: CARD_LAST4,
      currency: "clp",
      statement_monto_facturado: "432.101",
      transaction_date: ddmmyyyy(PAID_ON),
      merchant,
      description_merged: merchant,
      raw_line: `${ddmmyyyy(PAID_ON)} ${merchant} $432.101`,
      installment_flag: "false",
      amount_clp: "432.101",
      row_id: "vitest-mortgage-receipt|0",
      dedupe_key: "vitest-mortgage-receipt|0",
      canonical_row_id: "vitest-mortgage-receipt|0",
    };
    const details = applyCanonicalCardStatements(parsedStatements([record]), { dryRun: false, full: true });
    expect(details.problems).toEqual([]);
    const lines = cardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.merchant).toBe(merchant);
    expect(lines[0]!.source_pdf).not.toMatch(/^import:web-paste/);
  });
});
