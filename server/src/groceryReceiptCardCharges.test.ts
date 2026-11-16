import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { expenseLineDisplayNames, type DisplayNameContext } from "./expenseDisplayNames.js";
import {
  chainBranchMerchant,
  GROCERY_CHAIN_LIDER,
  groceryBranchMerchantByCardLine,
  pairReceiptsWithCardLines,
  type CardPaidReceipt,
  type ReceiptChargeLine,
} from "./groceryReceiptCardCharges.js";
import { ensureVitestCreditCardFixtures, getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
import { foldVendorName, vendorCatalogFromEntries } from "./vendorCatalog.js";

const ACQUIRER = "SUPERMERCADO PLAZA LYON LTDA.";
const BRANCH_MERCHANT = "EXPRESS LYON, SANTIAGO";

const receipt = (purchase_ymd: string, card_paid_clp: number, extra: Partial<CardPaidReceipt> = {}): CardPaidReceipt => ({
  account_id: 1,
  purchase_ymd,
  card_paid_clp,
  branch_merchant: BRANCH_MERCHANT,
  ...extra,
});

const line = (id: number, purchase_on: string | null, amount_clp: number, extra: Partial<ReceiptChargeLine> = {}): ReceiptChargeLine => ({
  source: "cc",
  statement_line_id: id,
  account_id: 1,
  purchase_on,
  amount_clp,
  merchant: ACQUIRER,
  ...extra,
});

const pairedIds = (receipts: CardPaidReceipt[], lines: ReceiptChargeLine[]) =>
  pairReceiptsWithCardLines(receipts, lines).map((p) => [p.receipt.purchase_ymd, p.line.statement_line_id]);

describe("pairReceiptsWithCardLines", () => {
  it("pairs the same card, the same pesos, from the purchase day to the window's last day", () => {
    const r = [receipt("2037-03-07", 1000)];
    expect(pairedIds(r, [line(1, "2037-03-07", 1000)])).toEqual([["2037-03-07", 1]]);
    // A Saturday purchase the bank lists on Monday; three days is the last one.
    expect(pairedIds(r, [line(2, "2037-03-09", 1000)])).toEqual([["2037-03-07", 2]]);
    expect(pairedIds(r, [line(3, "2037-03-10", 1000)])).toEqual([["2037-03-07", 3]]);
    expect(pairedIds(r, [line(4, "2037-03-11", 1000)])).toEqual([]);
    expect(pairedIds(r, [line(5, "2037-03-06", 1000)])).toEqual([]);
  });

  it("leaves another amount, another card, a dollar line, a cuota line and a non-card line alone", () => {
    const r = [receipt("2037-03-07", 1000)];
    expect(
      pairedIds(r, [
        line(1, "2037-03-07", 1001),
        line(2, "2037-03-07", 1000, { account_id: 2 }),
        line(3, "2037-03-07", 1000, { amount_usd: 1 }),
        line(4, "2037-03-07", 1000, { installment_flag: 1 }),
        line(5, "2037-03-07", 1000, { source: "checking" }),
        line(6, null, 1000),
      ])
    ).toEqual([]);
  });

  it("one receipt takes the nearest of two same-amount lines, and only that one", () => {
    const r = [receipt("2037-03-07", 1000)];
    expect(pairedIds(r, [line(1, "2037-03-09", 1000), line(2, "2037-03-08", 1000)])).toEqual([["2037-03-07", 2]]);
  });

  it("nearest first over every receipt: a later receipt keeps its own day's line", () => {
    const receipts = [receipt("2037-03-07", 1000), receipt("2037-03-09", 1000)];
    expect(pairedIds(receipts, [line(1, "2037-03-09", 1000)])).toEqual([["2037-03-09", 1]]);
    expect(pairedIds(receipts, [line(1, "2037-03-09", 1000), line(2, "2037-03-07", 1000)])).toEqual([
      ["2037-03-07", 2],
      ["2037-03-09", 1],
    ]);
  });

  it("equally near, the line already under the branch's merchant is the receipt's", () => {
    const lines = [line(1, "2037-03-07", 1000), line(2, "2037-03-07", 1000, { merchant: `${BRANCH_MERCHANT} (T)` })];
    expect(pairedIds([receipt("2037-03-07", 1000)], lines)).toEqual([["2037-03-07", 2]]);
  });
});

describe("a grocery receipt names its card charge", () => {
  const seed = (pattern: string, display: string) =>
    ({ kind: "branch" as const, pattern: foldVendorName(pattern), display, source: "seed" as const });
  const ctx = (byLine: Map<number, string>): DisplayNameContext => ({
    catalog: vendorCatalogFromEntries([seed("EXPRESS", "Lider Express"), seed("JUMBO", "Jumbo")]),
    counterparties: new Map(),
    brands: [],
    cardMerchantsByAccount: new Map(),
    groceryBranchMerchantByLine: byLine,
  });
  const names = (merchant: string, id: number, byLine: Map<number, string>) =>
    expenseLineDisplayNames(
      { source: "cc", merchant, account_id: 1, statement_line_id: id, payment_receipt: undefined, transfer_counterparty: undefined },
      ctx(byLine)
    );

  it("an acquirer's legal name reads as the catalog's name for the receipt's branch", () => {
    expect(names(ACQUIRER, 7, new Map([[7, BRANCH_MERCHANT]]))).toEqual({ display_merchant: "Lider Express (Lyon)" });
  });

  it("a line without a paired receipt, or whose branch the catalog does not list, stays as it was", () => {
    const plain = names(ACQUIRER, 7, new Map());
    expect(names(ACQUIRER, 8, new Map([[7, BRANCH_MERCHANT]]))).toEqual(plain);
    expect(names(ACQUIRER, 7, new Map([[7, "VITEST UNLISTED, SANTIAGO"]]))).toEqual(plain);
  });

  it("a name the catalog already knows is untouched", () => {
    expect(names("JUMBO BILBAO", 7, new Map([[7, BRANCH_MERCHANT]]))).toEqual({ display_merchant: "Jumbo (Bilbao)" });
  });
});

describe("groceryBranchMerchantByCardLine (stored receipts)", () => {
  // The synthetic registry (`test/ccCardsFixture.json`) declares this branch for the Lider chain.
  const BRANCH = "CALLE FICTICIA #123";
  const SOURCE_KEY_PREFIX = "vitest-receipt-charge-";
  let accountId = 0;

  function insertReceipt(n: number, chain: string, branch: string, purchaseYmd: string, paidClp: number, status: string): void {
    db.prepare(
      `INSERT INTO grocery_receipts
         (receipt_key, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
          total_clp, payments_json, card_paid_clp, card_line_status, card_line_account_id)
       VALUES (?, 'email', ?, ?, ?, ?, 'VITEST - SANTIAGO', ?, ?, '[]', ?, ?, ?)`
    ).run(
      `${chain}|${SOURCE_KEY_PREFIX}${n}|${purchaseYmd}`,
      `${SOURCE_KEY_PREFIX}${n}`,
      `${SOURCE_KEY_PREFIX}${n}`,
      chain,
      branch,
      `${purchaseYmd} 17:06:00`,
      paidClp,
      paidClp,
      status,
      accountId
    );
  }

  beforeAll(() => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) throw new Error("vitest CC fixture master missing (NW_TRACKER_TEST_DB unset?)");
    accountId = id;
    insertReceipt(1, GROCERY_CHAIN_LIDER, BRANCH, "2037-04-04", 4321, "covered");
    insertReceipt(2, GROCERY_CHAIN_LIDER, "VITEST UNMAPPED BRANCH", "2037-04-10", 5432, "pending_branch");
    insertReceipt(3, "vitest-chain-without-card-rule", BRANCH, "2037-04-15", 6543, "matched");
  });

  afterAll(() => {
    db.prepare(`DELETE FROM grocery_receipts WHERE source_key LIKE ?`).run(`${SOURCE_KEY_PREFIX}%`);
  });

  it("a chain without a card rule and an unmapped branch name no merchant", () => {
    expect(chainBranchMerchant(GROCERY_CHAIN_LIDER, BRANCH)).toBe("EXPRESS FICTICIA, SANTIAGO");
    expect(chainBranchMerchant(GROCERY_CHAIN_LIDER, "VITEST UNMAPPED BRANCH")).toBeNull();
    expect(chainBranchMerchant("vitest-chain-without-card-rule", BRANCH)).toBeNull();
  });

  it("maps the covered receipt's bank line to its branch's merchant, whatever the line prints", () => {
    const lines = [
      line(101, "2037-04-06", 4321, { account_id: accountId }),
      line(102, "2037-04-10", 5432, { account_id: accountId }),
      line(103, "2037-04-15", 6543, { account_id: accountId }),
      line(104, "2037-04-04", 4321, { account_id: accountId, source: "checking" }),
    ];
    expect([...groceryBranchMerchantByCardLine(lines)]).toEqual([[101, "EXPRESS FICTICIA, SANTIAGO"]]);
    expect(groceryBranchMerchantByCardLine([]).size).toBe(0);
  });
});
