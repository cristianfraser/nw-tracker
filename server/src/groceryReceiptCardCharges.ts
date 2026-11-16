/**
 * A grocery receipt's card charge, found at read time: which card line is the purchase a receipt
 * paid with the chain's card, and the bank merchant its branch maps to.
 *
 * The receipt import writes the line itself under the branch's merchant, unless the bank's listing
 * got there first (`card_line_status = 'covered'`): that line may carry the acquirer's legal name,
 * which says nothing of the store the receipt names. Line ids are replaced on re-import and when
 * the statement settles the listing, so the pair is never stored: it is rebuilt from the receipt's
 * card account, day and pesos.
 *
 * Rule: a receipt with a card leg (`card_paid_clp > 0`, `card_line_account_id` set) pairs with a
 * one-shot peso card line of that account for exactly those pesos, dated from the purchase day to
 * `MATCH_WINDOWS.planted_charge` days after it (the bank may list a Saturday purchase on Monday).
 * One-to-one, nearest day first over every receipt and line; at the same distance a line already
 * under the branch's merchant goes first, then receipt and line order.
 */
import { daysBetweenIso, dayWithinWindow, isIsoDate } from "nw-tracker-contracts";
import { ccCardRegistry } from "./ccCardRegistry.js";
import { db } from "./db.js";
import { bankMerchantForBranchMap, resolveBranchMerchant } from "./groceryBranchLearning.js";
import { pairOneToOne } from "./matching/pairing.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

export const GROCERY_CHAIN_LIDER = "lider";

/** Chains whose receipts name a card charge: printed branch (every rendering) → the bank's merchant. */
const CHAIN_DECLARED_BRANCH_MERCHANTS: Readonly<Record<string, () => Readonly<Record<string, string>>>> = {
  [GROCERY_CHAIN_LIDER]: () => ccCardRegistry().boleta_sucursal_merchants,
};

/**
 * The bank's merchant string for a chain's printed branch (declared, else learned); null for a
 * chain without a card rule or a branch nobody mapped yet.
 */
export function chainBranchMerchant(chain: string, branch: string): string | null {
  const declared = CHAIN_DECLARED_BRANCH_MERCHANTS[chain];
  return declared ? resolveBranchMerchant(chain, branch, declared()) : null;
}

export type CardPaidReceipt = {
  account_id: number;
  purchase_ymd: string;
  card_paid_clp: number;
  /** The bank merchant of the receipt's branch; null when the branch has none. */
  branch_merchant: string | null;
};

/** The fields of an expense line the pairing reads (`FlowCcExpenseLineRow`). */
export type ReceiptChargeLine = {
  source: string;
  statement_line_id: number;
  account_id: number;
  purchase_on: string | null;
  amount_clp: number;
  amount_usd?: number | null;
  installment_flag?: number;
  merchant: string | null;
};

/** A one-shot peso card line with a day: the only lines a receipt's charge can be. */
function chargeDay(l: ReceiptChargeLine): string | null {
  if (l.source !== "cc" || l.amount_usd != null || l.installment_flag) return null;
  return l.purchase_on != null && isIsoDate(l.purchase_on) ? l.purchase_on : null;
}

/** Receipts paired with their card line. Pure: the rule in the header alone. */
export function pairReceiptsWithCardLines<R extends CardPaidReceipt, L extends ReceiptChargeLine>(
  receipts: readonly R[],
  lines: readonly L[]
): { receipt: R; line: L }[] {
  const charges = lines.flatMap((line) => {
    const day = chargeDay(line);
    return day ? [{ line, day }] : [];
  });
  const underBranchMerchant = (r: CardPaidReceipt, l: ReceiptChargeLine): boolean =>
    r.branch_merchant != null && l.merchant != null && bankMerchantForBranchMap(l.merchant) === r.branch_merchant;
  const { pairs } = pairOneToOne(receipts, charges, {
    strategy: "nearest_global",
    accepts: (r, c) =>
      c.line.account_id === r.account_id &&
      c.line.amount_clp === r.card_paid_clp &&
      dayWithinWindow(r.purchase_ymd, c.day, MATCH_WINDOWS.planted_charge),
    distance: (r, c) => daysBetweenIso(r.purchase_ymd, c.day),
    tieBreak: (a, b) =>
      Number(underBranchMerchant(b.left, b.right.line)) - Number(underBranchMerchant(a.left, a.right.line)),
  });
  return pairs.map((p) => ({ receipt: p.left, line: p.right.line }));
}

/** Every receipt with a card leg on one of `accountIds`, oldest first, with its branch's merchant. */
export function loadCardPaidReceipts(accountIds: ReadonlySet<number>): CardPaidReceipt[] {
  if (accountIds.size === 0) return [];
  const rows = db
    .prepare(
      `SELECT store_chain, branch, card_line_account_id AS account_id,
              substr(purchased_at, 1, 10) AS purchase_ymd, card_paid_clp
       FROM grocery_receipts
       WHERE card_paid_clp > 0 AND card_line_account_id IS NOT NULL
       ORDER BY purchased_at, id`
    )
    .all() as { store_chain: string; branch: string; account_id: number; purchase_ymd: string; card_paid_clp: number }[];
  const merchants = new Map<string, string | null>();
  const out: CardPaidReceipt[] = [];
  for (const r of rows) {
    if (!accountIds.has(r.account_id)) continue;
    const key = `${r.store_chain}|${r.branch}`;
    if (!merchants.has(key)) merchants.set(key, chainBranchMerchant(r.store_chain, r.branch));
    out.push({
      account_id: r.account_id,
      purchase_ymd: r.purchase_ymd,
      card_paid_clp: r.card_paid_clp,
      branch_merchant: merchants.get(key) ?? null,
    });
  }
  return out;
}

/** Card line (`statement_line_id`) → the bank merchant of the branch its grocery receipt names. */
export function groceryBranchMerchantByCardLine(lines: readonly ReceiptChargeLine[]): Map<number, string> {
  const accountIds = new Set(lines.filter((l) => l.source === "cc").map((l) => l.account_id));
  const out = new Map<number, string>();
  for (const { receipt, line } of pairReceiptsWithCardLines(loadCardPaidReceipts(accountIds), lines)) {
    if (receipt.branch_merchant) out.set(line.statement_line_id, receipt.branch_merchant);
  }
  return out;
}
