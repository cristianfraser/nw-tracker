import { dedupeInstallmentPurchaseLedgerRows } from "./ccInstallmentLedgerDb.js";
import { db } from "./db.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import { merchantStemForInstallmentDedupe } from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccInstallmentLedgerDb.js";

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

export function merchantsMatchForCrossDedupe(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizeCcExpenseMerchantKey(a);
  const nb = normalizeCcExpenseMerchantKey(b);
  if (na && nb && na === nb) return true;
  const sa = merchantStemForInstallmentDedupe(a);
  const sb = merchantStemForInstallmentDedupe(b);
  if (!sa || !sb) return false;
  const ua = sa.toUpperCase();
  const ub = sb.toUpperCase();
  return ua === ub || ua.startsWith(ub) || ub.startsWith(ua);
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

export function installmentPurchaseMatchesOneShot(
  purchase: CcInstallmentPurchaseMatch,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  if (!purchaseAmountsMatch(purchase.total_amount_clp, amountClp)) return false;
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

export function listOneShotLinesForAccount(accountId: number): CcOneShotLineMatch[] {
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

export function oneShotStatementLineIdsSupersededByInstallmentPurchases(
  accountId: number
): Set<number> {
  const redundant = new Set<number>();
  const purchases = listInstallmentPurchasesForAccount(accountId);
  if (purchases.length === 0) return redundant;
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
        redundant.add(line.statement_line_id);
        break;
      }
    }
  }
  return redundant;
}

export function shouldSkipOneShotStatementImport(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  return findMatchingInstallmentPurchase(accountId, merchant, purchaseDateIso, amountClp) != null;
}

const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);

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
  const redundant = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  const ids = [...redundant];
  const removed_count = deleteStatementLinesByIds(ids);
  if (opts?.recompute !== false && removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId);
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
  const removed_count = deleteStatementLinesByIds(ids);
  if (removed_count > 0) {
    upsertCreditCardValuationsFromLedger(accountId);
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
