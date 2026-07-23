import { dedupeInstallmentPurchaseLedgerRows } from "./ccInstallmentLedgerDb.js";
import { db } from "./db.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import {
  normalizeCcExpenseMerchantKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import { merchantStemForInstallmentDedupe } from "./ccInstallmentLineDedupe.js";
import { normalizeTransactionDateIso, parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";

export const selLineCategory = db.prepare<[number]>(
  `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
);

export const upsertUniqueCat = db.prepare(
  `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
   VALUES (?, ?, ?)
   ON CONFLICT(account_id, purchase_key) DO NOTHING`
);

export type CcInstallmentPurchaseMatch = {
  id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
};

export type CcOneShotLineMatch = {
  statement_line_id: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  amount_clp: number;
  purchase_date_iso: string | null;
};

export function purchaseAmountsMatch(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  const tol = Math.max(500, Math.round(0.02 * Math.max(a, b)));
  return Math.abs(a - b) <= tol;
}

/**
 * Strip BCI Lider merchant suffixes before cross-source comparison:
 * - PDF merchants append " (T)" (e.g. "ENTEL HOGAR (T)")
 * - Web-paste merchants append ",CITY" (e.g. "ENTEL HOGAR,SANTIAGO")
 */
function normalizeBciMerchantForDedupe(merchant: string | null | undefined): string {
  const s = normalizeCcExpenseMerchantKey(merchant);
  return s
    .replace(/\s*\(T\)\s*$/i, "")   // strip trailing " (T)" from PDF lines
    .replace(/,\s*[A-ZÁÉÍÓÚÑ ]+$/i, "") // strip trailing ",CITY" from web-paste lines
    .trim();
}

export function merchantsMatchForCrossDedupe(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeCcExpenseMerchantKey(a);
  const nb = normalizeCcExpenseMerchantKey(b);
  if (na && nb && na === nb) return true;
  if (plazaLyonMerchantsMatch(a, b)) return true;
  // BCI Lider: PDF adds " (T)", web-paste adds ",CITY" — strip both and compare.
  const ba = normalizeBciMerchantForDedupe(a);
  const bb = normalizeBciMerchantForDedupe(b);
  if (ba && bb && ba === bb) return true;
  const sa = merchantStemForInstallmentDedupe(a);
  const sb = merchantStemForInstallmentDedupe(b);
  if (!sa || !sb) return false;
  const ua = sa.toUpperCase();
  const ub = sb.toUpperCase();
  return ua === ub || ua.startsWith(ub) || ub.startsWith(ua);
}

/** Web-paste «EXPRESS PLAZA L» vs PDF «RECAUDACION EX PLAZA LYON» (same Lyon parking charge). */
export function plazaLyonMerchantsMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const ua = normalizeCcExpenseMerchantKey(a);
  const ub = normalizeCcExpenseMerchantKey(b);
  if (!ua || !ub) return false;
  const plazaA = ua.includes("PLAZA") && (ua.includes("LYON") || ua.endsWith("PLAZA L"));
  const plazaB = ub.includes("PLAZA") && (ub.includes("LYON") || ub.endsWith("PLAZA L"));
  if (!plazaA || !plazaB) return false;
  return (
    ua.includes("RECAUDACION") ||
    ub.includes("RECAUDACION") ||
    ua.includes("EXPRESS") ||
    ub.includes("EXPRESS")
  );
}

function purchaseDateIsoFromLine(
  transaction_date: string | null,
  posting_date: string | null
): string | null {
  return (
    parseDdMmYyToIso(transaction_date ?? "") ?? parseDdMmYyToIso(posting_date ?? "")
  );
}

export function listInstallmentPurchasesForAccount(
  accountId: number
): CcInstallmentPurchaseMatch[] {
  const rows = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(accountId) as CcInstallmentPurchaseMatch[];
  return dedupeInstallmentPurchaseLedgerRows(rows);
}

/**
 * A one-shot line represents an installment purchase when its amount matches either the full
 * principal or a single cuota. The bank's website lists a purchase as the full total at buy time
 * (e.g. a 6-cuota TGR buy of 92.918), then later re-lists the same purchase as the per-cuota
 * charge that will post (15.486) — a re-import of that cuota line must still dedupe against the
 * converted installment. Mirrors `plainPurchaseLineAmountBlocksInstallmentMatch` in
 * ccInstallmentPurchaseTotalLines.ts.
 */
export function installmentPurchaseAmountMatchesOneShot(
  purchase: CcInstallmentPurchaseMatch,
  amountClp: number
): boolean {
  if (purchaseAmountsMatch(purchase.total_amount_clp, amountClp)) return true;
  const n = purchase.cuotas_totales;
  if (n && n > 1 && Number.isFinite(purchase.total_amount_clp) && purchase.total_amount_clp > 0) {
    const perCuota = Math.round(purchase.total_amount_clp / n);
    if (purchaseAmountsMatch(perCuota, amountClp)) return true;
  }
  return false;
}

export function installmentPurchaseMatchesOneShot(
  purchase: CcInstallmentPurchaseMatch,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  if (!installmentPurchaseAmountMatchesOneShot(purchase, amountClp)) return false;
  if (!merchantsMatchForCrossDedupe(purchase.merchant, merchant)) return false;
  if (purchaseDateIso && purchase.purchase_date !== purchaseDateIso) return false;
  return true;
}

export function findMatchingInstallmentPurchase(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): CcInstallmentPurchaseMatch | null {
  const abs = Math.abs(Math.trunc(amountClp));
  if (abs <= 0) return null;
  for (const p of listInstallmentPurchasesForAccount(accountId)) {
    if (installmentPurchaseMatchesOneShot(p, merchant, purchaseDateIso, abs)) return p;
  }
  return null;
}

/**
 * Read-scope memo for the account-level line scan + superseded set. Only active inside
 * `withCcOneShotScanCache` (synchronous read-only builds like detalle por mes, which call
 * these once per billing month). Import/write flows never enter the scope, so their dedupe
 * decisions always re-read the DB.
 */
let oneShotScanCache: {
  lines: Map<number, CcOneShotLineMatch[]>;
  superseded: Map<number, Set<number>>;
} | null = null;

export function withCcOneShotScanCache<T>(fn: () => T): T {
  if (oneShotScanCache) return fn(); // already inside a scope — reuse it
  oneShotScanCache = { lines: new Map(), superseded: new Map() };
  try {
    return fn();
  } finally {
    oneShotScanCache = null;
  }
}

export function listOneShotLinesForAccount(accountId: number): CcOneShotLineMatch[] {
  const cached = oneShotScanCache?.lines.get(accountId);
  if (cached) return cached;
  const out = listOneShotLinesForAccountUncached(accountId);
  oneShotScanCache?.lines.set(accountId, out);
  return out;
}

function listOneShotLinesForAccountUncached(accountId: number): CcOneShotLineMatch[] {
  const rows = db
    .prepare(
      `SELECT l.id AS statement_line_id, l.merchant, l.transaction_date, l.posting_date,
              l.amount_clp, l.amount_usd, l.installment_flag,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd,
              s.statement_date, s.currency AS statement_currency
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.installment_flag = 0`
    )
    .all(accountId) as {
    statement_line_id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    amount_clp: number | null;
    amount_usd: number | null;
    installment_flag: number;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
    statement_date: string;
    statement_currency: string;
  }[];

  const out: CcOneShotLineMatch[] = [];
  for (const r of rows) {
    const fxDateIso = parseDdMmYyToIso(r.statement_date);
    const amount = effectiveCcExpenseLineAmountClp(
      {
        installment_flag: 0,
        amount_clp: r.amount_clp,
        amount_usd: r.amount_usd,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
        statement_currency: r.statement_currency,
      },
      fxDateIso
    );
    if (amount == null || amount <= 0) continue;
    out.push({
      statement_line_id: r.statement_line_id,
      merchant: r.merchant,
      transaction_date: r.transaction_date,
      posting_date: r.posting_date,
      amount_clp: amount,
      purchase_date_iso: purchaseDateIsoFromLine(r.transaction_date, r.posting_date),
    });
  }
  return out;
}

export function findOneShotLinesMatchingPurchase(
  accountId: number,
  purchase: CcInstallmentPurchaseMatch
): number[] {
  const ids: number[] = [];
  for (const line of listOneShotLinesForAccount(accountId)) {
    if (
      installmentPurchaseMatchesOneShot(
        purchase,
        line.merchant,
        line.purchase_date_iso,
        line.amount_clp
      )
    ) {
      ids.push(line.statement_line_id);
    }
  }
  return ids;
}

function oneShotLinesSupersededByInstallmentPurchases(
  accountId: number
): Map<number, CcInstallmentPurchaseMatch> {
  const superseded = new Map<number, CcInstallmentPurchaseMatch>();
  const purchases = listInstallmentPurchasesForAccount(accountId);
  if (purchases.length === 0) return superseded;
  for (const line of listOneShotLinesForAccount(accountId)) {
    for (const p of purchases) {
      if (
        installmentPurchaseMatchesOneShot(
          p,
          line.merchant,
          line.purchase_date_iso,
          line.amount_clp
        )
      ) {
        superseded.set(line.statement_line_id, p);
        break;
      }
    }
  }
  return superseded;
}

export function oneShotStatementLineIdsSupersededByInstallmentPurchases(
  accountId: number
): Set<number> {
  const cached = oneShotScanCache?.superseded.get(accountId);
  if (cached) return cached;
  const out = new Set(oneShotLinesSupersededByInstallmentPurchases(accountId).keys());
  oneShotScanCache?.superseded.set(accountId, out);
  return out;
}

export function shouldSkipOneShotStatementImport(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  return findMatchingInstallmentPurchase(accountId, merchant, purchaseDateIso, amountClp) != null;
}

const dbOneShotCandidates = db.prepare<[number, number]>(
  `SELECT l.merchant, l.transaction_date, l.posting_date
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?`
);

/**
 * Returns true when an existing one-shot line has the same date, same CLP amount, and a
 * fuzzy-matching merchant — catches re-imports where the bank truncated the merchant name.
 */
export function oneShotLineFuzzyMatchExists(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  if (!purchaseDateIso || amountClp <= 0) return false;
  const rows = dbOneShotCandidates.all(accountId, amountClp) as {
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
  }[];
  for (const row of rows) {
    const rowDateIso = purchaseDateIsoFromLine(row.transaction_date, row.posting_date);
    if (rowDateIso !== purchaseDateIso) continue;
    if (merchantsMatchForCrossDedupe(row.merchant, merchant)) return true;
  }
  return false;
}

const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);

/**
 * Earliest transaction date among these lines — read BEFORE deleting them. Removing evidence
 * changes past balances just as adding it does, so the stamps written after that date are
 * contradicted too.
 */
export function earliestTransactionDateForLineIds(lineIds: number[]): string | null {
  let out: string | null = null;
  const sel = db.prepare(`SELECT transaction_date FROM cc_statement_lines WHERE id = ?`);
  for (const id of lineIds) {
    const row = sel.get(id) as { transaction_date: string | null } | undefined;
    const iso = normalizeTransactionDateIso(row?.transaction_date ?? null);
    if (iso && (out == null || iso < out)) out = iso;
  }
  return out;
}

export function deleteStatementLinesByIds(lineIds: number[]): number {
  let n = 0;
  for (const id of lineIds) {
    n += delLines.run(id).changes;
  }
  return n;
}

export type CcCrossImportDedupeResult = {
  removed_line_ids: number[];
  removed_count: number;
};

export function removeOneShotLinesSupersededByInstallmentPurchases(
  accountId: number,
  opts?: { recompute?: boolean }
): CcCrossImportDedupeResult {
  const superseded = oneShotLinesSupersededByInstallmentPurchases(accountId);
  for (const [lineId, purchase] of superseded) {
    const cat = selLineCategory.get(lineId) as { category_id: number } | undefined;
    if (cat?.category_id != null) {
      const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId,
        purchaseDateIso: purchase.purchase_date,
        cuotasTotales: purchase.cuotas_totales,
        totalAmountClp: purchase.total_amount_clp,
        merchant: purchase.merchant,
      });
      upsertUniqueCat.run(accountId, purchaseKey, cat.category_id);
    }
  }
  const ids = [...superseded.keys()];
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed_count = deleteStatementLinesByIds(ids);
  if (opts?.recompute !== false && removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
    recomputeCcBillingMonthBalances(accountId);
  }
  return { removed_line_ids: ids, removed_count };
}

export function removeOneShotLinesForInstallmentPurchase(
  accountId: number,
  purchaseId: number
): CcCrossImportDedupeResult {
  const purchase = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as CcInstallmentPurchaseMatch | undefined;
  if (!purchase) return { removed_line_ids: [], removed_count: 0 };
  const ids = findOneShotLinesMatchingPurchase(accountId, purchase);
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed_count = deleteStatementLinesByIds(ids);
  if (removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
    recomputeCcBillingMonthBalances(accountId);
  }
  return { removed_line_ids: ids, removed_count };
}

export function backfillCcCrossImportDedupe(accountId?: number): {
  accounts: number;
  removed_total: number;
  by_account: { account_id: number; removed_count: number; removed_line_ids: number[] }[];
} {
  const accountIds =
    accountId != null
      ? [accountId]
      : (
          db
            .prepare(
              `SELECT DISTINCT account_id AS id FROM cc_installment_purchases
               UNION
               SELECT DISTINCT s.account_id AS id FROM cc_statements s`
            )
            .all() as { id: number }[]
        ).map((r) => r.id);

  const by_account: {
    account_id: number;
    removed_count: number;
    removed_line_ids: number[];
  }[] = [];
  let removed_total = 0;
  for (const id of accountIds) {
    const r = removeOneShotLinesSupersededByInstallmentPurchases(id);
    if (r.removed_count > 0) {
      by_account.push({
        account_id: id,
        removed_count: r.removed_count,
        removed_line_ids: r.removed_line_ids,
      });
      removed_total += r.removed_count;
    }
  }
  return { accounts: accountIds.length, removed_total, by_account };
}
