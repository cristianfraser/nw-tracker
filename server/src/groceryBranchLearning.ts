/**
 * Boleta branch → bank merchant string, learned from the card's own lines.
 *
 * A receipt paid with a chain's co-branded card gets an open-month card line of its own only
 * when the printed branch («SUC:» header) maps to the bank's exact merchant string for that
 * store — the dedupe key the feed/statement will print. The map has two sources: the registry
 * (`cc-cards.json` `boleta_sucursal_merchants`, hand-declared) and `grocery_branch_merchants`
 * (migration 184), which this module LEARNS. A receipt at a branch neither source names is
 * flagged on its row (`card_line_status = 'pending_branch'` + the card master it would have
 * written to) — no line written, nothing guessed, and the import step does not fail — and the
 * first line the bank itself writes on that card for the same day and the same pesos, from the
 * paste textarea, the nightly feed or the statement PDF, IS that purchase. The pairing runs
 * inside the shared card-write funnel (`mergeCcAccountFromParsedRows`) and again at each
 * receipt import: it stores (chain, branch) → the line's merchant (statement convention, the
 * trailing « (T)» stripped) and marks the receipt `matched`, so the next receipt at that store
 * carries its own line through the normal path.
 *
 * Refusals are explicit, never guesses: two same-day-same-amount lines, or two pending
 * receipts claiming the same day and amount, leave the receipt pending and are reported as
 * ambiguous; a learned merchant that disagrees with the registry throws. Lines the receipt
 * importer wrote itself (`<chain>-boleta|…` raw lines) are never candidates — they are not
 * bank evidence — and a line one receipt already learned from is not offered to another.
 *
 * Leaf module by design (db + the date parser only): the funnel imports it, so it must import
 * nothing that leads back to the funnel.
 */
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";

export type GroceryCardLineStatus = "created" | "covered" | "pending_branch" | "matched";

/** raw_line prefix of a line the receipt importer wrote itself (`lider-boleta|<nº>|<date>|<clp>`). */
export function receiptCardLineRawLinePrefix(chain: string): string {
  return `${chain}-boleta`;
}

/** The bank's merchant string as the map stores it: the statement's « (T)» suffix stripped. */
export function bankMerchantForBranchMap(merchant: string): string {
  return merchant.replace(/\s*\(T\)\s*$/i, "").trim();
}

const selectLearned = db.prepare(
  `SELECT merchant, source FROM grocery_branch_merchants WHERE store_chain = ? AND branch = ?`
);
const insertLearned = db.prepare(
  `INSERT INTO grocery_branch_merchants
     (store_chain, branch, merchant, source, learned_receipt_id, learned_statement_line_id)
   VALUES (?, ?, ?, 'learned', ?, ?)`
);
const selectStatus = db.prepare(`SELECT card_line_status FROM grocery_receipts WHERE id = ?`);
const updateStatus = db.prepare(
  `UPDATE grocery_receipts SET card_line_status = ?, card_line_account_id = ? WHERE id = ?`
);
const selectPending = db.prepare(
  `SELECT id AS receipt_id, store_chain, branch, card_line_account_id,
          substr(purchased_at, 1, 10) AS purchase_ymd, card_paid_clp
   FROM grocery_receipts
   WHERE card_line_account_id = ? AND card_line_status = 'pending_branch'
   ORDER BY purchased_at, id`
);
const selectCandidateLines = db.prepare(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.raw_line
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?
     AND l.id NOT IN (SELECT learned_statement_line_id FROM grocery_branch_merchants
                      WHERE learned_statement_line_id IS NOT NULL)
   ORDER BY l.id`
);

/**
 * Registry entry first, learned row second. Both present and different is a data error, not a
 * preference: one of them is wrong about what the bank prints, and importing on either would
 * silently split the store's lines across two merchants.
 */
export function resolveBranchMerchant(
  chain: string,
  branch: string,
  registryMap: Readonly<Record<string, string>>
): string | null {
  const declared = registryMap[branch] ?? null;
  const learned = (selectLearned.get(chain, branch) as { merchant: string } | undefined)?.merchant ?? null;
  if (declared && learned && declared !== learned) {
    throw new Error(
      `Branch «${branch}» (${chain}) maps to «${declared}» in cc-cards.json boleta_sucursal_merchants ` +
        `but to «${learned}» in grocery_branch_merchants — fix one before importing`
    );
  }
  return declared ?? learned;
}

export function learnedBranchMerchant(chain: string, branch: string): { merchant: string; source: string } | null {
  return (selectLearned.get(chain, branch) as { merchant: string; source: string } | undefined) ?? null;
}

export function receiptCardLineStatus(receiptId: number): GroceryCardLineStatus | null {
  const row = selectStatus.get(receiptId) as { card_line_status: GroceryCardLineStatus | null } | undefined;
  return row?.card_line_status ?? null;
}

export function markReceiptCardLine(receiptId: number, status: GroceryCardLineStatus, accountId: number): void {
  updateStatus.run(status, accountId, receiptId);
}

export type PendingBranchReceipt = {
  receipt_id: number;
  store_chain: string;
  branch: string;
  card_line_account_id: number;
  /** YYYY-MM-DD of the printed local purchase datetime. */
  purchase_ymd: string;
  card_paid_clp: number;
};

export function listPendingBranchReceipts(accountId: number): PendingBranchReceipt[] {
  return selectPending.all(accountId) as PendingBranchReceipt[];
}

export type BranchLearnOutcome =
  | { status: "learned"; merchant: string; statement_line_id: number }
  | { status: "no_candidate" }
  | { status: "ambiguous"; candidate_line_ids: number[] };

type CandidateLine = {
  id: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  raw_line: string | null;
};

function lineYmd(row: CandidateLine): string | null {
  return (
    parseDdMmYyToIso(String(row.transaction_date ?? "")) ??
    parseDdMmYyToIso(String(row.posting_date ?? ""))
  );
}

/**
 * Pair one pending receipt with the bank's line for its day and pesos on its card. Exactly one
 * candidate learns the branch and marks the receipt matched; zero or several leave it pending.
 */
export function learnBranchForPendingReceipt(receipt: PendingBranchReceipt): BranchLearnOutcome {
  if (!(receipt.card_paid_clp > 0)) return { status: "no_candidate" };
  const ownPrefix = `${receiptCardLineRawLinePrefix(receipt.store_chain)}|`;
  const rows = selectCandidateLines.all(receipt.card_line_account_id, receipt.card_paid_clp) as CandidateLine[];
  const candidates = rows.filter(
    (r) =>
      !String(r.raw_line ?? "").startsWith(ownPrefix) &&
      String(r.merchant ?? "").trim() !== "" &&
      lineYmd(r) === receipt.purchase_ymd
  );
  if (candidates.length === 0) return { status: "no_candidate" };
  if (candidates.length > 1) return { status: "ambiguous", candidate_line_ids: candidates.map((c) => c.id) };
  const line = candidates[0]!;
  const merchant = bankMerchantForBranchMap(String(line.merchant));
  const existing = learnedBranchMerchant(receipt.store_chain, receipt.branch);
  if (existing && existing.merchant !== merchant) {
    throw new Error(
      `Branch «${receipt.branch}» (${receipt.store_chain}) is already mapped to «${existing.merchant}» ` +
        `but statement line ${line.id} for receipt ${receipt.receipt_id} prints «${merchant}»`
    );
  }
  db.transaction(() => {
    if (!existing) insertLearned.run(receipt.store_chain, receipt.branch, merchant, receipt.receipt_id, line.id);
    updateStatus.run("matched", receipt.card_line_account_id, receipt.receipt_id);
  })();
  return { status: "learned", merchant, statement_line_id: line.id };
}

export type GroceryBranchLearningResult = {
  learned: { receipt_id: number; branch: string; merchant: string; statement_line_id: number }[];
  ambiguous: { receipt_id: number; branch: string; candidate_line_ids: number[] }[];
};

/**
 * The card-write hook: every pending receipt on this card master gets one pairing attempt
 * against the lines now in the ledger. Two pending receipts sharing a day and amount are both
 * left pending (one line cannot say which store it was).
 */
export function learnGroceryBranchesFromCardLines(accountId: number): GroceryBranchLearningResult {
  const result: GroceryBranchLearningResult = { learned: [], ambiguous: [] };
  const pending = listPendingBranchReceipts(accountId);
  if (pending.length === 0) return result;
  const twins = new Map<string, number>();
  for (const r of pending) {
    const k = `${r.purchase_ymd}|${r.card_paid_clp}`;
    twins.set(k, (twins.get(k) ?? 0) + 1);
  }
  for (const r of pending) {
    if ((twins.get(`${r.purchase_ymd}|${r.card_paid_clp}`) ?? 0) > 1) {
      result.ambiguous.push({ receipt_id: r.receipt_id, branch: r.branch, candidate_line_ids: [] });
      continue;
    }
    const outcome = learnBranchForPendingReceipt(r);
    if (outcome.status === "learned") {
      result.learned.push({
        receipt_id: r.receipt_id,
        branch: r.branch,
        merchant: outcome.merchant,
        statement_line_id: outcome.statement_line_id,
      });
    } else if (outcome.status === "ambiguous") {
      result.ambiguous.push({ receipt_id: r.receipt_id, branch: r.branch, candidate_line_ids: outcome.candidate_line_ids });
    }
  }
  return result;
}
