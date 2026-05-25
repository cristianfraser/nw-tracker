import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  merchantsMatchForCrossDedupe,
  purchaseAmountsMatch,
} from "./ccCrossImportDedupe.js";
import {
  lineHasUniquePurchaseMode,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import {
  isInstallmentContractSummaryMerchant,
  isUnindexedInstallmentResumenLine,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { dedupeInstallmentPurchaseLedgerRows } from "./ccInstallmentLedgerDb.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export type InstallmentPurchaseRow = {
  id: number;
  account_id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
};

function purchaseOnIso(raw: string): string {
  return raw.length >= 10 ? raw.slice(0, 10) : raw;
}

export function installmentPurchaseIdentityKey(
  accountId: number,
  purchaseOn: string,
  cuotasTotal: number,
  merchantKey: string
): string {
  return `${accountId}:${purchaseOn}:${cuotasTotal}:${merchantKey}`;
}

function identityKeyFromLine(ln: FlowCcExpenseLineRow): string | null {
  if (!ln.purchase_on || !ln.nro_cuota_total) return null;
  return installmentPurchaseIdentityKey(
    ln.account_id,
    ln.purchase_on,
    ln.nro_cuota_total,
    ln.merchant_key
  );
}

function loadInstallmentPurchases(accountIds: number[]): InstallmentPurchaseRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, account_id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE account_id IN (${ph})`
    )
    .all(...accountIds) as InstallmentPurchaseRow[];
  return dedupeInstallmentPurchaseLedgerRows(rows);
}

export function purchaseLineMatchesInstallmentPurchase(
  ln: FlowCcExpenseLineRow,
  pr: InstallmentPurchaseRow
): boolean {
  if (ln.account_id !== pr.account_id) return false;
  if (ln.purchase_on !== purchaseOnIso(pr.purchase_date)) return false;
  return merchantsMatchForCrossDedupe(ln.merchant, pr.merchant);
}

function findMatchingCuotaLine(
  cuotaLines: readonly FlowCcExpenseLineRow[],
  pr: InstallmentPurchaseRow
): FlowCcExpenseLineRow | undefined {
  const purchaseOn = purchaseOnIso(pr.purchase_date);
  const merchantKey = normalizeCcExpenseMerchantKey(pr.merchant);
  return (
    cuotaLines.find(
      (ln) =>
        ln.line_role === "installment_cuota" &&
        ln.account_id === pr.account_id &&
        ln.purchase_on === purchaseOn &&
        ln.nro_cuota_total === pr.cuotas_totales &&
        ln.merchant_key === merchantKey
    ) ??
    cuotaLines.find(
      (ln) =>
        ln.line_role === "installment_cuota" &&
        ln.account_id === pr.account_id &&
        ln.purchase_on === purchaseOn &&
        ln.nro_cuota_total === pr.cuotas_totales
    )
  );
}

function estimateInstallmentTotalFromCuotas(group: readonly FlowCcExpenseLineRow[]): number {
  const first = group[0]!;
  const n = first.nro_cuota_total ?? group.length;
  if (n <= 0) return 0;
  const distinctCuotas = new Set(
    group.map((ln) => ln.nro_cuota_current).filter((c): c is number => c != null && c > 0)
  );
  if (distinctCuotas.size >= n) {
    return group.reduce((s, ln) => s + ln.amount_clp, 0);
  }
  const cuota1 = group.find((ln) => ln.nro_cuota_current === 1);
  const perCuota = cuota1?.amount_clp ?? Math.max(...group.map((ln) => ln.amount_clp));
  return perCuota * n;
}

function syntheticPurchaseKey(
  accountId: number,
  purchaseOn: string,
  cuotasTotal: number,
  merchantKey: string
): string {
  return `installment-synth:${accountId}:${purchaseOn}:${cuotasTotal}:${merchantKey}`;
}

function resolveCategoryStatementLineId(
  cuotaLines: readonly FlowCcExpenseLineRow[],
  opts: {
    accountId: number;
    purchaseOn: string;
    cuotasTotales: number;
    merchantKey: string;
    merchant: string | null;
    matchCuota?: FlowCcExpenseLineRow;
  }
): number | null {
  if (opts.matchCuota && opts.matchCuota.statement_line_id > 0) {
    return opts.matchCuota.statement_line_id;
  }
  const sibling = cuotaLines.find(
    (ln) =>
      ln.statement_line_id > 0 &&
      ln.line_role === "installment_cuota" &&
      ln.account_id === opts.accountId &&
      ln.purchase_on === opts.purchaseOn &&
      ln.nro_cuota_total === opts.cuotasTotales &&
      (ln.merchant_key === opts.merchantKey ||
        merchantsMatchForCrossDedupe(ln.merchant, opts.merchant))
  );
  return sibling?.statement_line_id ?? null;
}

function buildSyntheticRow(opts: {
  statementLineId: number;
  accountId: number;
  purchaseOn: string;
  purchaseMonth: string;
  amountClp: number;
  merchant: string | null;
  merchantKey: string;
  cuotasTotales: number;
  categorySlug: string;
  categoryUnique: boolean;
  categoryStatementLineId: number | null;
}): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: opts.statementLineId,
    account_id: opts.accountId,
    expense_month: opts.purchaseMonth,
    billing_month: opts.purchaseMonth,
    purchase_month: opts.purchaseMonth,
    occurred_on: opts.purchaseOn,
    purchase_on: opts.purchaseOn,
    statement_date: "",
    amount_clp: opts.amountClp,
    amount_usd: null,
    merchant: opts.merchant,
    merchant_key: opts.merchantKey,
    category_slug: opts.categorySlug,
    category_unique: opts.categoryUnique,
    installment_flag: 1,
    nro_cuota_current: null,
    nro_cuota_total: opts.cuotasTotales,
    line_role: "installment_purchase_total",
    category_statement_line_id: opts.categoryStatementLineId,
  };
}

function representativeScore(
  ln: FlowCcExpenseLineRow,
  synth: FlowCcExpenseLineRow
): number {
  if (ln.statement_line_id <= 0) return 0;
  if (ln.line_role === "installment_purchase_total") return 0;
  if (ln.account_id !== synth.account_id) return 0;
  if (ln.purchase_month !== synth.purchase_month) return 0;
  if (ln.purchase_on !== synth.purchase_on) return 0;
  if (!merchantsMatchForCrossDedupe(ln.merchant, synth.merchant)) return 0;

  if (ln.line_role === "installment_cuota") {
    if (ln.nro_cuota_current === 0) return 70;
    if (isUnindexedInstallmentResumenLine(ln)) return 80;
    return 0;
  }

  if (ln.line_role !== "purchase") return 0;
  if (isInstallmentContractSummaryMerchant(ln.merchant)) return 100;
  if (isUnindexedInstallmentResumenLine(ln)) return 80;
  if (purchaseAmountsMatch(ln.amount_clp, synth.amount_clp)) return 60;
  return 40;
}

function findRepresentativeLineIndex(
  lines: readonly FlowCcExpenseLineRow[],
  synth: FlowCcExpenseLineRow
): number {
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.line_role === "installment_cuota" && (ln.nro_cuota_current ?? 0) > 0) {
      continue;
    }
    const score = representativeScore(ln, synth);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function promoteLineToInstallmentPurchaseTotal(
  ln: FlowCcExpenseLineRow,
  synth: FlowCcExpenseLineRow
): FlowCcExpenseLineRow {
  const stem = merchantStemForInstallmentDedupe(ln.merchant);
  const merchant = stem || synth.merchant || ln.merchant;
  return {
    ...ln,
    line_role: "installment_purchase_total",
    installment_flag: 1,
    nro_cuota_current: null,
    nro_cuota_total: synth.nro_cuota_total,
    amount_clp: synth.amount_clp,
    merchant,
    merchant_key: synth.merchant_key || ln.merchant_key,
    category_slug: synth.category_slug || ln.category_slug,
    category_unique: synth.category_unique,
    category_statement_line_id:
      synth.category_statement_line_id ?? ln.category_statement_line_id ?? null,
  };
}

function inferInstallmentPurchaseKey(
  ln: FlowCcExpenseLineRow,
  purchases: readonly InstallmentPurchaseRow[]
): string | null {
  for (const pr of purchases) {
    if (!purchaseLineMatchesInstallmentPurchase(ln, pr)) continue;
    return installmentPurchaseIdentityKey(
      pr.account_id,
      purchaseOnIso(pr.purchase_date),
      pr.cuotas_totales,
      normalizeCcExpenseMerchantKey(pr.merchant)
    );
  }
  return identityKeyFromLine(ln);
}

function purchaseLineSupersededByExistingTotal(
  ln: FlowCcExpenseLineRow,
  totals: readonly FlowCcExpenseLineRow[]
): boolean {
  if (ln.line_role !== "purchase") return false;
  for (const total of totals) {
    if (total.line_role !== "installment_purchase_total") continue;
    if (ln.account_id !== total.account_id) continue;
    if (ln.purchase_on !== total.purchase_on) continue;
    if (!merchantsMatchForCrossDedupe(ln.merchant, total.merchant)) continue;
    return true;
  }
  return false;
}

function shouldDropPurchaseLineForInstallmentTotal(
  ln: FlowCcExpenseLineRow,
  totalKeys: ReadonlySet<string>,
  purchases: readonly InstallmentPurchaseRow[],
  totals: readonly FlowCcExpenseLineRow[]
): boolean {
  if (purchaseLineSupersededByExistingTotal(ln, totals)) return true;
  if (ln.line_role !== "purchase") return false;
  const key = inferInstallmentPurchaseKey(ln, purchases);
  if (key && totalKeys.has(key)) return true;
  if (isInstallmentContractSummaryMerchant(ln.merchant)) {
    for (const pr of purchases) {
      if (purchaseLineMatchesInstallmentPurchase(ln, pr)) return true;
    }
  }
  return false;
}

function collectInstallmentTotalKeys(lines: readonly FlowCcExpenseLineRow[]): Set<string> {
  const keys = new Set<string>();
  for (const ln of lines) {
    if (ln.line_role !== "installment_purchase_total") continue;
    const key = identityKeyFromLine(ln);
    if (key) keys.add(key);
  }
  return keys;
}

/** One synthetic row per installment purchase for the Compras table / total mode. */
export function buildInstallmentPurchaseTotalLines(
  accountIds: number[],
  cuotaLines: readonly FlowCcExpenseLineRow[],
  maps: ReturnType<typeof loadCcExpenseCategoryMaps>
): FlowCcExpenseLineRow[] {
  const purchases = loadInstallmentPurchases(accountIds);
  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } = maps;
  const synthetics: FlowCcExpenseLineRow[] = [];

  for (const pr of purchases) {
    const purchaseOn = purchaseOnIso(pr.purchase_date);
    const purchaseMonth = monthKeyFromYmd(purchaseOn);
    const merchantKey = normalizeCcExpenseMerchantKey(pr.merchant);
    const matchCuota = findMatchingCuotaLine(cuotaLines, pr);
    const merchant = pr.merchant ?? matchCuota?.merchant ?? null;
    const purchaseKey = matchCuota
      ? resolveCcExpensePurchaseKey(matchCuota.statement_line_id)
      : syntheticPurchaseKey(pr.account_id, purchaseOn, pr.cuotas_totales, merchantKey);

    const categorySlug =
      matchCuota?.category_slug ??
      resolveCcExpenseCategorySlug({
        statementLineId: matchCuota?.statement_line_id ?? -pr.id,
        accountId: pr.account_id,
        merchantKey,
        purchaseKey,
        lineOverrides,
        merchantRules,
        uniquePurchases,
      });

    const categoryUnique =
      matchCuota?.category_unique ??
      lineHasUniquePurchaseMode(pr.account_id, purchaseKey, uniquePurchases, uniquePurchaseModeKeys);

    const categoryStatementLineId = resolveCategoryStatementLineId(cuotaLines, {
      accountId: pr.account_id,
      purchaseOn,
      cuotasTotales: pr.cuotas_totales,
      merchantKey,
      merchant,
      matchCuota,
    });

    synthetics.push(
      buildSyntheticRow({
        statementLineId: -pr.id,
        accountId: pr.account_id,
        purchaseOn,
        purchaseMonth,
        amountClp: pr.total_amount_clp,
        merchant,
        merchantKey,
        cuotasTotales: pr.cuotas_totales,
        categorySlug,
        categoryUnique,
        categoryStatementLineId,
      })
    );
  }

  const groups = new Map<string, FlowCcExpenseLineRow[]>();
  for (const ln of cuotaLines) {
    if (ln.line_role !== "installment_cuota") continue;
    if (!ln.purchase_on || !ln.nro_cuota_total) continue;
    const key = `${ln.account_id}:${ln.purchase_on}:${ln.nro_cuota_total}:${ln.merchant_key}`;
    const list = groups.get(key) ?? [];
    list.push(ln);
    groups.set(key, list);
  }

  let fallbackId = -1_000_000;
  for (const [, group] of groups) {
    const first = group[0]!;
    const purchaseOn = first.purchase_on!;
    const purchaseMonth = monthKeyFromYmd(purchaseOn);
    const already = synthetics.some(
      (s) =>
        s.account_id === first.account_id &&
        s.purchase_on === purchaseOn &&
        s.nro_cuota_total === first.nro_cuota_total &&
        merchantsMatchForCrossDedupe(s.merchant, first.merchant)
    );
    if (already) continue;

    const amountClp = estimateInstallmentTotalFromCuotas(group);
    if (amountClp <= 0) continue;

    synthetics.push(
      buildSyntheticRow({
        statementLineId: fallbackId--,
        accountId: first.account_id,
        purchaseOn,
        purchaseMonth,
        amountClp,
        merchant: first.merchant,
        merchantKey: first.merchant_key,
        cuotasTotales: first.nro_cuota_total ?? group.length,
        categorySlug: first.category_slug,
        categoryUnique: first.category_unique,
        categoryStatementLineId: first.statement_line_id > 0 ? first.statement_line_id : null,
      })
    );
  }

  return synthetics;
}

/**
 * Promote purchase-month statement rows to installment totals when they already
 * represent the purchase; append synthetics only when no statement row exists.
 */
function pickPreferredInstallmentPurchaseTotal(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): FlowCcExpenseLineRow {
  if (a.statement_line_id > 0 && b.statement_line_id <= 0) return a;
  if (b.statement_line_id > 0 && a.statement_line_id <= 0) return b;
  const aSummary = isInstallmentContractSummaryMerchant(a.merchant);
  const bSummary = isInstallmentContractSummaryMerchant(b.merchant);
  if (aSummary && !bSummary) return b;
  if (bSummary && !aSummary) return a;
  return a.statement_line_id >= b.statement_line_id ? a : b;
}

function dropInstallmentResumenCuotasSupersededByTotals(
  lines: readonly FlowCcExpenseLineRow[]
): FlowCcExpenseLineRow[] {
  const totalKeys = collectInstallmentTotalKeys(lines);
  if (totalKeys.size === 0) return [...lines];

  return lines.filter((ln) => {
    if (ln.line_role !== "installment_cuota") return true;
    if ((ln.nro_cuota_current ?? 0) > 0) return true;
    const key = identityKeyFromLine(ln);
    if (key && totalKeys.has(key)) return false;
    if (isInstallmentContractSummaryMerchant(ln.merchant)) return false;
    if (isUnindexedInstallmentResumenLine(ln)) return false;
    return true;
  });
}

function dedupeInstallmentPurchaseTotalLines(lines: FlowCcExpenseLineRow[]): FlowCcExpenseLineRow[] {
  const totalsByKey = new Map<string, FlowCcExpenseLineRow>();
  const out: FlowCcExpenseLineRow[] = [];
  for (const ln of lines) {
    if (ln.line_role !== "installment_purchase_total") {
      out.push(ln);
      continue;
    }
    const key =
      identityKeyFromLine(ln) ??
      installmentPurchaseIdentityKey(
        ln.account_id,
        ln.purchase_on ?? "",
        ln.nro_cuota_total ?? 0,
        ln.merchant_key
      );
    const prev = totalsByKey.get(key);
    if (!prev) {
      totalsByKey.set(key, ln);
      continue;
    }
    totalsByKey.set(key, pickPreferredInstallmentPurchaseTotal(prev, ln));
  }
  return [...out, ...totalsByKey.values()];
}

export function mergeInstallmentPurchaseTotalsIntoLines(
  lines: FlowCcExpenseLineRow[],
  accountIds: number[],
  maps: ReturnType<typeof loadCcExpenseCategoryMaps>
): FlowCcExpenseLineRow[] {
  const purchases = loadInstallmentPurchases(accountIds);
  const synthetics = buildInstallmentPurchaseTotalLines(accountIds, lines, maps);
  const result = [...lines];
  const pendingSynths: FlowCcExpenseLineRow[] = [];
  const satisfiedTotalKeys = new Set<string>();

  for (const synth of synthetics) {
    const synthKey = identityKeyFromLine(synth);
    if (synthKey && satisfiedTotalKeys.has(synthKey)) continue;

    const repIdx = findRepresentativeLineIndex(result, synth);
    if (repIdx >= 0) {
      result[repIdx] = promoteLineToInstallmentPurchaseTotal(result[repIdx]!, synth);
      if (synthKey) satisfiedTotalKeys.add(synthKey);
    } else if (!synthKey || !satisfiedTotalKeys.has(synthKey)) {
      pendingSynths.push(synth);
      if (synthKey) satisfiedTotalKeys.add(synthKey);
    }
  }

  const totalKeys = collectInstallmentTotalKeys(result);
  for (const synth of pendingSynths) {
    const key = identityKeyFromLine(synth);
    if (key) totalKeys.add(key);
  }

  const totalLines = result.filter((ln) => ln.line_role === "installment_purchase_total");
  const filtered = result.filter(
    (ln) => !shouldDropPurchaseLineForInstallmentTotal(ln, totalKeys, purchases, totalLines)
  );
  const merged = dedupeInstallmentPurchaseTotalLines([...filtered, ...pendingSynths]);
  return dropInstallmentResumenCuotasSupersededByTotals(merged);
}
