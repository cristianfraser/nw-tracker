import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  merchantsMatchForCrossDedupe,
  purchaseAmountsMatch,
} from "./ccCrossImportDedupe.js";
import {
  categoryUniqueForExpenseLine,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  registerGenericUniquePurchaseMode,
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
import type { FlowCcExpenseLineBeforeNotes } from "./ccExpensePurchaseNotes.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import type { FlowCcExpenseLineRow, FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

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

/**
 * Dedupe key for installment purchase totals that includes the amount, so two genuinely
 * distinct purchases sharing account+date+cuotas+merchant (e.g. two EXPRESS PLAZA L charges on
 * the same day, one converted to a 1.200.000 installment and another to 1.267.034) are kept as
 * separate totals instead of collapsing into one. The amount-free identityKeyFromLine is still
 * used for matching cuota/purchase lines to totals, where the amount legitimately differs.
 */
function installmentTotalDedupeKey(ln: FlowCcExpenseLineRow): string | null {
  const base = identityKeyFromLine(ln);
  if (!base) return null;
  return `${base}:${Math.round(ln.amount_clp)}`;
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

/**
 * A plain purchase line (not a contract-summary / resumen line) only represents — or is
 * superseded by — an installment purchase when its amount matches either the full principal
 * or a single cuota (statements sometimes list the first cuota as the "purchase"). Two charges
 * with the same merchant and date but an unrelated amount are different purchases; without this
 * guard the total for one hijacks the sibling's line (matched by merchant+date alone). Summary /
 * resumen lines carry different amounts by design and are matched elsewhere.
 */
function plainPurchaseLineAmountBlocksInstallmentMatch(
  ln: FlowCcExpenseLineRow,
  installmentTotalClp: number,
  cuotasTotal: number | null
): boolean {
  if (ln.line_role !== "purchase") return false;
  if (isInstallmentContractSummaryMerchant(ln.merchant)) return false;
  if (isUnindexedInstallmentResumenLine(ln)) return false;
  if (purchaseAmountsMatch(ln.amount_clp, installmentTotalClp)) return false;
  if (cuotasTotal && cuotasTotal > 0) {
    const perCuota = Math.round(installmentTotalClp / cuotasTotal);
    if (purchaseAmountsMatch(ln.amount_clp, perCuota)) return false;
  }
  return true;
}

function findMatchingCuotaLine(
  cuotaLines: readonly FlowCcExpenseLineRow[],
  pr: InstallmentPurchaseRow
): FlowCcExpenseLineRow | undefined {
  const purchaseOn = purchaseOnIso(pr.purchase_date);
  const merchantKey = normalizeCcExpenseMerchantKey(pr.merchant);
  // Prefer the cuota whose ledger total matches this purchase's amount. Two purchases that share
  // account/date/cuotas/merchant but differ by amount (e.g. two same-day EXPRESS PLAZA 3-cuotas buys)
  // are only distinguishable here by `installment_total_clp` — cuota drafts have no purchase_key yet —
  // so this stops one purchase's total line from inheriting the other's category / Único state.
  if (pr.total_amount_clp != null && Number.isFinite(pr.total_amount_clp)) {
    const wantTotal = Math.round(pr.total_amount_clp);
    const exact = cuotaLines.find(
      (ln) =>
        ln.line_role === "installment_cuota" &&
        ln.account_id === pr.account_id &&
        ln.purchase_on === purchaseOn &&
        ln.nro_cuota_total === pr.cuotas_totales &&
        ln.merchant_key === merchantKey &&
        ln.installment_total_clp != null &&
        Math.round(ln.installment_total_clp) === wantTotal
    );
    if (exact) return exact;
  }
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

/**
 * A cuota group is keyed by account+purchase_on+cuotas_total+merchant (amount-free). When no
 * `cc_installment_purchases` row backs the group, we reconstruct the purchase total by summing
 * its cuotas — which is only valid if the group is a single purchase. Two distinct installments
 * that share that key but have different cuota amounts (e.g. two EXPRESS PLAZA L charges on the
 * same day billed as 3 cuotas of 400.000 and 3 of 422.345) would be silently summed into one
 * wrong total. Detect that (same cuota index appearing with conflicting amounts) and fail fast.
 *
 * This is an unlikely edge: manual conversions always create a purchase row (keyed per id/amount),
 * so it can only arise from PDF-only installments. Potential fix when it does: key cuota groups by
 * an amount bucket, or carry `cc_installment_purchases.id` onto cuota lines and build one synthetic
 * total per distinct purchase instead of per merchant/date/cuotas group.
 */
function assertSingleInstallmentInCuotaGroup(group: readonly FlowCcExpenseLineRow[]): void {
  const amountsByCuota = new Map<number, number[]>();
  for (const ln of group) {
    const idx = ln.nro_cuota_current;
    if (idx == null || idx <= 0) continue;
    const list = amountsByCuota.get(idx) ?? [];
    list.push(ln.amount_clp);
    amountsByCuota.set(idx, list);
  }
  for (const [idx, amounts] of amountsByCuota) {
    for (let i = 1; i < amounts.length; i++) {
      if (!purchaseAmountsMatch(amounts[0]!, amounts[i]!)) {
        const first = group[0];
        throw new Error(
          `Ambiguous installment cuota group for account ${first?.account_id} ` +
            `${first?.purchase_on} (${first?.merchant_key}): cuota ${idx} has conflicting amounts ` +
            `${amounts.join(", ")}. Multiple installment purchases share the same ` +
            `merchant/date/cuotas key with no purchase row to disambiguate — cannot reconstruct ` +
            `per-purchase totals. See assertSingleInstallmentInCuotaGroup for the fix.`
        );
      }
    }
  }
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
}): FlowCcExpenseLineBeforeNotes {
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
    amount_usd_at_expense: expenseGastosAmountUsdAtDate(opts.amountClp, null, opts.purchaseOn),
    merchant: opts.merchant,
    merchant_key: opts.merchantKey,
    category_slug: opts.categorySlug,
    category_unique: opts.categoryUnique,
    installment_flag: 1,
    installment_total_clp: opts.amountClp,
    nro_cuota_current: null,
    nro_cuota_total: opts.cuotasTotales,
    line_role: "installment_purchase_total",
    category_statement_line_id: opts.categoryStatementLineId,
    origin_card_last4: null,
    primary_card_last4: null,
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
  // Promote a first-cuota-amount purchase line, but never an unrelated same-merchant/same-day
  // sibling whose amount matches neither the principal nor a cuota (that is a different purchase).
  if (!plainPurchaseLineAmountBlocksInstallmentMatch(ln, synth.amount_clp, synth.nro_cuota_total)) {
    return 40;
  }
  return 0;
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
    installment_total_clp: synth.amount_clp,
    nro_cuota_current: null,
    nro_cuota_total: synth.nro_cuota_total,
    amount_clp: synth.amount_clp,
    merchant,
    merchant_key: synth.merchant_key || ln.merchant_key,
    category_slug: synth.category_slug || ln.category_slug,
    category_unique: ln.category_unique || synth.category_unique,
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
    if (plainPurchaseLineAmountBlocksInstallmentMatch(ln, pr.total_amount_clp, pr.cuotas_totales)) {
      continue;
    }
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
    if (plainPurchaseLineAmountBlocksInstallmentMatch(ln, total.amount_clp, total.nro_cuota_total)) {
      continue;
    }
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
  cuotaLines: readonly FlowCcExpenseLineRowDraft[],
  maps: ReturnType<typeof loadCcExpenseCategoryMaps>
): FlowCcExpenseLineBeforeNotes[] {
  const purchases = loadInstallmentPurchases(accountIds);
  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } = maps;
  const synthetics: FlowCcExpenseLineBeforeNotes[] = [];

  for (const pr of purchases) {
    const purchaseOn = purchaseOnIso(pr.purchase_date);
    const purchaseMonth = monthKeyFromYmd(purchaseOn);
    const merchantKey = normalizeCcExpenseMerchantKey(pr.merchant);
    const matchCuota = findMatchingCuotaLine(cuotaLines, pr);
    const merchant = pr.merchant ?? matchCuota?.merchant ?? null;
    const purchaseKey = matchCuota
      ? resolveCcExpensePurchaseKey(matchCuota.statement_line_id)
      : syntheticPurchaseKey(pr.account_id, purchaseOn, pr.cuotas_totales, merchantKey);

    if (!matchCuota) {
      registerGenericUniquePurchaseMode(
        pr.account_id,
        purchaseKey,
        merchantKey,
        uniquePurchaseModeKeys,
        { statementLineId: -pr.id }
      );
    }

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
        uniquePurchaseModeKeys,
      });

    const categoryUnique =
      matchCuota?.category_unique ??
      categoryUniqueForExpenseLine(
        pr.account_id,
        purchaseKey,
        merchantKey,
        uniquePurchases,
        uniquePurchaseModeKeys
      );

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

    assertSingleInstallmentInCuotaGroup(group);
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
      installmentTotalDedupeKey(ln) ??
      `${installmentPurchaseIdentityKey(
        ln.account_id,
        ln.purchase_on ?? "",
        ln.nro_cuota_total ?? 0,
        ln.merchant_key
      )}:${Math.round(ln.amount_clp)}`;
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
  lines: FlowCcExpenseLineRowDraft[],
  accountIds: number[],
  maps: ReturnType<typeof loadCcExpenseCategoryMaps>
): FlowCcExpenseLineRowDraft[] {
  const purchases = loadInstallmentPurchases(accountIds);
  const synthetics = buildInstallmentPurchaseTotalLines(accountIds, lines, maps);
  const result = [...lines];
  const pendingSynths: FlowCcExpenseLineRowDraft[] = [];
  const satisfiedTotalKeys = new Set<string>();

  for (const synth of synthetics) {
    // Amount-aware key so two distinct same-merchant/same-day/same-cuotas purchases each keep
    // their own total instead of the second being skipped as already satisfied.
    const synthKey = installmentTotalDedupeKey(synth);
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
