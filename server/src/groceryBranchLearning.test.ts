import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importCcWebPasteLines } from "./accountImports.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { db } from "./db.js";
import {
  bankMerchantForBranchMap,
  learnBranchForPendingReceipt,
  learnGroceryBranchesFromCardLines,
  learnedBranchMerchant,
  receiptCardLineRawLinePrefix,
  receiptCardLineStatus,
  resolveBranchMerchant,
  type PendingBranchReceipt,
} from "./groceryBranchLearning.js";
import { snapshotTables } from "./test/snapshotTables.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

/** The funnel test pastes onto the synthetic preset's master ·4321; restore its tables after. */
const restoreCcTables = snapshotTables([
  "cc_statements",
  "cc_statement_lines",
  "cc_expense_line_categories",
  "cc_billing_month_balances",
  "valuations",
  "import_batches",
]);

/**
 * Pairing runs against ANY credit-card master (it keys on the receipt's stored card account),
 * so the isolated vitest Santander master stands in for the Lider card. Receipts are synthetic
 * rows flagged pending_branch directly, the way the importer leaves them.
 */
const CHAIN = "vitest-chain";
const KEY_PREFIX = "vitest-branch-";

describe("groceryBranchLearning", () => {
  let accountId = 0;
  let statementId = 0;
  let seq = 0;

  function insertPendingReceipt(
    branch: string,
    purchaseYmd: string,
    paidClp: number,
    cardAccountId = accountId
  ): PendingBranchReceipt {
    seq += 1;
    const number = `${KEY_PREFIX}${seq}`;
    const r = db
      .prepare(
        `INSERT INTO grocery_receipts
           (receipt_key, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
            total_clp, payments_json, card_paid_clp, card_line_status, card_line_account_id)
         VALUES (?, 'lider_email', ?, ?, ?, ?, 'VITEST - SANTIAGO', ?, ?, ?, ?, 'pending_branch', ?)`
      )
      .run(
        `${CHAIN}|${number}|${purchaseYmd}`,
        `<${number}@vitest>`,
        number,
        CHAIN,
        branch,
        `${purchaseYmd} 19:02:11`,
        paidClp,
        JSON.stringify([{ method: "tarjeta_vitest", amount_clp: paidClp }]),
        paidClp,
        cardAccountId
      );
    return {
      receipt_id: Number(r.lastInsertRowid),
      store_chain: CHAIN,
      branch,
      card_line_account_id: cardAccountId,
      purchase_ymd: purchaseYmd,
      card_paid_clp: paidClp,
    };
  }

  function insertLine(merchant: string, transactionDate: string, amountClp: number, rawLine = "vitest"): number {
    seq += 1;
    const r = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, amount_usd,
           installment_flag, dedupe_key, parser_row_id, raw_line
         ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`
      )
      .run(statementId, transactionDate, merchant, amountClp, `vitest-branch|${seq}`, `vitest-branch|${seq}`, rawLine);
    return Number(r.lastInsertRowid);
  }

  beforeAll(() => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) throw new Error("vitest CC fixture master missing (NW_TRACKER_TEST_DB unset?)");
    accountId = id;
    wipeVitestCcFixtureData();
    const r = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, card_last4, layout, currency
         ) VALUES (?, 'santander', '2037-01-26 estado de cuenta tarjeta 0000.pdf', '26/01/2037', '0000', 'compact', 'clp')`
      )
      .run(accountId);
    statementId = Number(r.lastInsertRowid);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM grocery_branch_merchants WHERE store_chain = ?`).run(CHAIN);
    db.prepare(`DELETE FROM grocery_receipts WHERE store_chain = ?`).run(CHAIN);
    wipeVitestCcFixtureData();
    restoreCcTables();
  });

  it("the raw-line prefix and the merchant normalisation match the Lider conventions", () => {
    expect(receiptCardLineRawLinePrefix("lider")).toBe("lider-boleta");
    expect(bankMerchantForBranchMap("HIPER FICTICIO., SANTIAGO (T)")).toBe("HIPER FICTICIO., SANTIAGO");
    expect(bankMerchantForBranchMap("EXPRESS LYON, SANTIAGO")).toBe("EXPRESS LYON, SANTIAGO");
  });

  it("no bank line for the day and amount leaves the receipt pending", () => {
    const receipt = insertPendingReceipt("VITEST SUC #1", "2037-01-04", 12345);
    expect(learnBranchForPendingReceipt(receipt)).toEqual({ status: "no_candidate" });
    expect(receiptCardLineStatus(receipt.receipt_id)).toBe("pending_branch");
    // A different day or a different amount is not the purchase either.
    insertLine("VITEST OTHER DAY", "5/1/2037", 12345);
    insertLine("VITEST OTHER AMOUNT", "4/1/2037", 12346);
    expect(learnBranchForPendingReceipt(receipt)).toEqual({ status: "no_candidate" });
  });

  it("the statement's line pairs the receipt and learns the branch (« (T)» stripped)", () => {
    const receipt = insertPendingReceipt("VITEST SUC #2", "2037-01-06", 66830);
    const lineId = insertLine("VITEST HIPER NUEVO., SANTIAGO (T)", "06/01/2037", 66830);
    expect(learnBranchForPendingReceipt(receipt)).toEqual({
      status: "learned",
      merchant: "VITEST HIPER NUEVO., SANTIAGO",
      statement_line_id: lineId,
    });
    expect(receiptCardLineStatus(receipt.receipt_id)).toBe("matched");
    expect(learnedBranchMerchant(CHAIN, "VITEST SUC #2")).toEqual({
      merchant: "VITEST HIPER NUEVO., SANTIAGO",
      source: "learned",
    });
    // The resolver now answers for the branch without a registry entry…
    expect(resolveBranchMerchant(CHAIN, "VITEST SUC #2", {})).toBe("VITEST HIPER NUEVO., SANTIAGO");
    // …agrees with a matching registry entry, and refuses a disagreeing one.
    expect(resolveBranchMerchant(CHAIN, "VITEST SUC #2", { "VITEST SUC #2": "VITEST HIPER NUEVO., SANTIAGO" })).toBe(
      "VITEST HIPER NUEVO., SANTIAGO"
    );
    expect(() => resolveBranchMerchant(CHAIN, "VITEST SUC #2", { "VITEST SUC #2": "SOMETHING ELSE" })).toThrow(
      /maps to «SOMETHING ELSE»/
    );
    // A line one receipt learned from is not offered to another.
    const twin = insertPendingReceipt("VITEST SUC #2-B", "2037-01-06", 66830);
    expect(learnBranchForPendingReceipt(twin)).toEqual({ status: "no_candidate" });
  });

  it("two same-day-same-amount lines are ambiguous: the receipt stays pending", () => {
    const receipt = insertPendingReceipt("VITEST SUC #3", "2037-01-08", 5000);
    const a = insertLine("VITEST CAFE A", "8/1/2037", 5000);
    const b = insertLine("VITEST CAFE B", "8/1/2037", 5000);
    expect(learnBranchForPendingReceipt(receipt)).toEqual({ status: "ambiguous", candidate_line_ids: [a, b] });
    expect(receiptCardLineStatus(receipt.receipt_id)).toBe("pending_branch");
    expect(learnedBranchMerchant(CHAIN, "VITEST SUC #3")).toBeNull();
  });

  it("a line the receipt importer wrote itself is never a candidate", () => {
    const receipt = insertPendingReceipt("VITEST SUC #4", "2037-01-09", 7777);
    insertLine("VITEST EXPRESS X, SANTIAGO", "9/1/2037", 7777, `${receiptCardLineRawLinePrefix(CHAIN)}|000123|2037-01-09|7777`);
    expect(learnBranchForPendingReceipt(receipt)).toEqual({ status: "no_candidate" });
  });

  it("the card-write funnel pairs pending receipts as the paste lands, and refuses twin receipts", () => {
    // The paste path resolves the card from its `credit_card_master|<issuer>|<last4>` identity,
    // which the vitest fixture lacks — the synthetic preset's Santander master ·4321 has it.
    const master = resolveMasterAccountIdForImportCardLast4("4321");
    if (master == null) throw new Error("synthetic preset master ·4321 missing from the test DB");
    const receipt = insertPendingReceipt("VITEST SUC #5", "2037-01-10", 9990, master);
    const twinA = insertPendingReceipt("VITEST SUC #6", "2037-01-11", 4440, master);
    const twinB = insertPendingReceipt("VITEST SUC #7", "2037-01-11", 4440, master);
    // Santander web pastes carry charges negative; the funnel stores them positive.
    const res = importCcWebPasteLines(master, {
      lines: [
        { transaction_date: "2037-01-10", merchant: "VITEST HIPER PASTE, SANTIAGO", amount_clp: -9990, amount_usd: null, currency: "clp", raw_line: "vitest paste 1" },
        { transaction_date: "2037-01-11", merchant: "VITEST TWIN, SANTIAGO", amount_clp: -4440, amount_usd: null, currency: "clp", raw_line: "vitest paste 2" },
      ],
      errors: [],
    });
    expect(res.inserted).toBe(2);
    expect(res.grocery_branch_learning.learned).toEqual([
      expect.objectContaining({ receipt_id: receipt.receipt_id, branch: "VITEST SUC #5", merchant: "VITEST HIPER PASTE, SANTIAGO" }),
    ]);
    expect(res.grocery_branch_learning.ambiguous.map((a) => a.receipt_id).sort()).toEqual(
      [twinA.receipt_id, twinB.receipt_id].sort()
    );
    expect(receiptCardLineStatus(receipt.receipt_id)).toBe("matched");
    expect(receiptCardLineStatus(twinA.receipt_id)).toBe("pending_branch");
    // A second write with nothing new to pair is a no-op.
    expect(learnGroceryBranchesFromCardLines(master).learned).toEqual([]);
  });
});
