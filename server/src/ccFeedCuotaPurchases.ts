/**
 * What the Santander card feed says about purchases in cuotas, applied to the ledger
 * (2026-09-26; rules in `ccCuotaPurchaseKinds.ts`, migration 186).
 *
 * The feed lists a cuota purchase at its full principal, typed «CUOTA COMERCIO» or «N/CUOTAS
 * PRECIO CONTADO». Imported as a one-shot line it counted the whole principal as billed in its
 * cycle, while the bank bills one cuota (precio contado) or nothing (cuota comercio) there.
 *
 *  - Count known (stamp tax, or printed in the type) → an ordinary installment plan
 *    (`source = 'manual'`, provenance in `cc_feed_installment_plans`) with its first cuota in the
 *    right facturación. The feed row then imports as an installment overlap, and creating the
 *    plan removes a one-shot line already on file for it. The statement's twin reconcile replaces
 *    the plan exactly as it replaces a hand-entered one.
 *  - Count unknown → the line stays (what is owed is the full principal from the purchase date
 *    either way) but is tagged `cuota_purchase_kind`, which keeps it out of the facturación's
 *    billed estimate and counts it as installment debt until the statement's plan supersedes it.
 */
import { db } from "./db.js";
import { createManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import {
  findMatchingInstallmentPurchase,
  merchantsMatchForCrossDedupe,
} from "./ccCrossImportDedupe.js";
import { billingMonthContainingPurchase } from "./ccManualBillingMonth.js";
import { firstCuotaBillingMonth, type CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { creditCardMasterMetaForAccount, type CcWebPasteLine } from "./ccWebPasteParse.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";

/** An open web-paste bucket line, as the feed matchers see it. */
export type CcOpenBucketLine = {
  id: number;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  installment_flag: number;
  cuota_purchase_kind: CcCuotaPurchaseKind | null;
  source_pdf: string;
};

const selOpenBucketLines = db.prepare<[number]>(
  `SELECT l.id, l.transaction_date, l.posting_date, l.merchant, l.amount_clp, l.amount_usd,
          l.installment_flag, l.cuota_purchase_kind, s.source_pdf
   FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste|open|%'
   ORDER BY l.id`
);

export function listOpenBucketLines(accountId: number): CcOpenBucketLine[] {
  return selOpenBucketLines.all(accountId) as CcOpenBucketLine[];
}

export function bucketLinePurchaseIso(line: Pick<CcOpenBucketLine, "transaction_date" | "posting_date">): string | null {
  return parseDdMmYyToIso(String(line.transaction_date ?? "")) ?? parseDdMmYyToIso(String(line.posting_date ?? ""));
}

function normMerchant(m: string | null | undefined): string {
  return String(m ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** A manual paste cuts merchants at exactly 15 characters; the feed prints them whole. */
function merchantsSame(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normMerchant(a);
  const nb = normMerchant(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length === 15 && long.startsWith(short)) return true;
  return merchantsMatchForCrossDedupe(a, b);
}

function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * The same purchase on a bucket line and a feed row: same currency, same amount (peso / cent),
 * a matching merchant (exact, the paste's 15-character cut, or the cross-import stem rule) and
 * dates at most `maxDayGap` apart (a pending authorization is restated up to a few days later).
 */
export function bucketLineMatchesFeedLine(
  line: CcOpenBucketLine,
  feed: CcWebPasteLine,
  maxDayGap: number
): boolean {
  const lineUsd = line.amount_usd != null && line.amount_usd !== 0;
  if (lineUsd !== (feed.currency === "usd")) return false;
  if (lineUsd) {
    if (Math.abs(Math.abs(line.amount_usd!) - Math.abs(feed.amount_usd ?? 0)) > 0.005) return false;
  } else if (Math.round(Math.abs(line.amount_clp ?? 0)) !== Math.round(Math.abs(feed.amount_clp))) {
    return false;
  }
  const lineIso = bucketLinePurchaseIso(line);
  if (!lineIso || dayGap(lineIso, feed.transaction_date) > maxDayGap) return false;
  return merchantsSame(line.merchant, feed.merchant);
}

export type CcFeedPlanCreated = {
  purchase_id: number;
  merchant: string;
  purchase_date: string;
  principal_clp: number;
  cuotas: number;
  kind: CcCuotaPurchaseKind;
  first_due_month: string;
};

const insProvenance = db.prepare(
  `INSERT INTO cc_feed_installment_plans
     (purchase_id, account_id, kind, cuotas_source, stamp_tax_clp, feed_file)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updFirstDue = db.prepare(`UPDATE cc_installment_purchases SET first_due_month = ? WHERE id = ?`);

/**
 * Create the plan for every feed cuota purchase whose count is known and that no plan covers yet
 * (a hand-entered plan for it is left to the type-aware first-due nudge).
 */
export function createPlansForFeedCuotaPurchases(
  accountId: number,
  lines: readonly CcWebPasteLine[],
  feedFile: string | null
): CcFeedPlanCreated[] {
  const created: CcFeedPlanCreated[] = [];
  const meta = creditCardMasterMetaForAccount(accountId);
  for (const line of lines) {
    const cp = line.cuota_purchase;
    if (!cp || cp.cuota_count == null || line.currency !== "clp") continue;
    const principal = Math.abs(Math.round(line.amount_clp));
    if (principal <= 0) continue;
    if (findMatchingInstallmentPurchase(accountId, line.merchant, line.transaction_date, principal)) continue;
    const firstDue = firstCuotaBillingMonth(
      cp.kind,
      billingMonthContainingPurchase(accountId, line.transaction_date)
    );
    const plan = db.transaction(() => {
      const p = createManualCcInstallmentPurchase(accountId, {
        purchase_date: line.transaction_date,
        total_amount_clp: principal,
        cuotas_totales: cp.cuota_count!,
        merchant: line.merchant,
        card_group: meta.cardGroup,
      });
      updFirstDue.run(firstDue, p.id);
      insProvenance.run(
        p.id,
        accountId,
        cp.kind,
        cp.count_source === "stamp_tax" ? "stamp_tax" : "feed_type",
        cp.stamp_tax_clp,
        feedFile
      );
      return p;
    })();
    created.push({
      purchase_id: plan.id,
      merchant: line.merchant,
      purchase_date: line.transaction_date,
      principal_clp: principal,
      cuotas: cp.cuota_count,
      kind: cp.kind,
      first_due_month: firstDue,
    });
  }
  if (created.length > 0) {
    // The plan's first due month was written after the create's own re-sync.
    recomputeCcBillingMonthBalances(accountId);
    upsertCreditCardValuationsFromLedger(accountId);
  }
  return created;
}

const updKind = db.prepare(`UPDATE cc_statement_lines SET cuota_purchase_kind = ? WHERE id = ?`);

/**
 * Tag the bucket line of each feed cuota purchase no plan covers (count unknown). Same day only —
 * the purchase row keeps its date — and the first untagged match per row. Returns the tagged ids.
 */
export function tagFeedCuotaPurchaseLines(
  accountId: number,
  lines: readonly CcWebPasteLine[]
): number[] {
  const typed = lines.filter((l) => l.cuota_purchase && l.currency === "clp");
  if (typed.length === 0) return [];
  const bucket = listOpenBucketLines(accountId);
  const used = new Set<number>();
  const tagged: number[] = [];
  for (const feed of typed) {
    const principal = Math.abs(Math.round(feed.amount_clp));
    if (findMatchingInstallmentPurchase(accountId, feed.merchant, feed.transaction_date, principal)) continue;
    const hit = bucket.find(
      (b) => !used.has(b.id) && !b.installment_flag && bucketLineMatchesFeedLine(b, feed, 0)
    );
    if (!hit) continue;
    used.add(hit.id);
    if (hit.cuota_purchase_kind === feed.cuota_purchase!.kind) continue;
    updKind.run(feed.cuota_purchase!.kind, hit.id);
    tagged.push(hit.id);
  }
  if (tagged.length > 0) recomputeCcBillingMonthBalances(accountId);
  return tagged;
}
