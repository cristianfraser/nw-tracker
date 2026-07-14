import { db } from "./db.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { cancelledInstallmentPurchaseIdsForAccount } from "./ccInstallmentLedgerDb.js";
import {
  clearUserDeclinedAutoCategory,
  isInstallmentContractPurchaseKey,
  markUserDeclinedAutoCategory,
} from "./ccAdditionalCardExpenseMatch.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { isExactGenericUniqueMerchantKey } from "./ccExpenseGenericUniqueMerchants.js";
import { isCcTraspasoDeudaMerchant } from "./ccStatementSection3.js";
import { legacyCheckingGastosPurchaseKey } from "./checkingGastosCategoryPersist.js";

/** Asset group slug for `GET /api/flows/expenses/credit-card` (all issuers, not one `credit_card_groups` row). */
export function primaryCreditCardExpensesGroupSlug(): string {
  return "credit_cards";
}

export const UNCLASSIFIED_CC_EXPENSE_SLUG = "unclassified";

/** Excluded from gasto del mes, acumulado, chart stacks, and page total. */
export const NO_CUENTA_CC_EXPENSE_SLUG = "no_cuenta";

/** Internal transfers to investments — same exclusion bucket as no_cuenta. */
export const DEPOSITS_CC_EXPENSE_SLUG = "deposits";

/** Mortgage principal on real-estate deposit matches — chart stack only, excluded from gastos total. */
export const REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG = "real_estate_amortization";

/** Carrying cost bucket for linked mortgage payments (interest + insurance). */
export const BILLS_CC_EXPENSE_SLUG = "bills";

/** Corriente ↔ vista and other checking cash auto-matches — excluded from gastos totals. */
export const CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG = "checking_internal_transfer";

export const CC_EXPENSE_TOTALS_EXCLUDED_SLUGS = new Set([
  NO_CUENTA_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
]);

export function isCcExpenseTotalsExcludedSlug(categorySlug: string): boolean {
  return CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(categorySlug);
}

export function countsTowardCcExpenseTotals(categorySlug: string): boolean {
  return !isCcExpenseTotalsExcludedSlug(categorySlug);
}

/** Installment schedule row with cuota index 0 (contract summary, not a billed cuota). */
export function isInstallmentCuotaZeroLine(line: {
  installment_flag: number;
  nro_cuota_current: number | null;
}): boolean {
  return line.installment_flag === 1 && line.nro_cuota_current === 0;
}

/** Positive charges counted in gasto del mes, chart stacks, and page total. */
export function countsTowardCcExpenseGastosMes(
  categorySlug: string,
  line: { installment_flag: number; nro_cuota_current: number | null }
): boolean {
  if (!countsTowardCcExpenseTotals(categorySlug)) return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  return true;
}

export type CcExpenseCategoryRow = {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  chart_color: string;
};

export function normalizeCcExpenseMerchantKey(merchant: string | null | undefined): string {
  const t = String(merchant ?? "").trim().replace(/\s+/g, " ");
  return t ? t.toUpperCase() : "";
}

/** Words in Santander transfer templates — not treated as a payee name. */
const GENERIC_TRANSFER_BOILERPLATE = new Set([
  "A",
  "AL",
  "BANCO",
  "BANCOS",
  "BCO",
  "DE",
  "E",
  "EL",
  "EN",
  "INTERNET",
  "LA",
  "LAS",
  "LOS",
  "MISMO",
  "O",
  "OTRO",
  "OTROS",
  "TERCERO",
  "TERCEROS",
  "TRANSF",
  "TRANSFERENCIA",
  "Y",
  "3O",
  "3RO",
]);

function matchesKnownGenericTransferTemplate(key: string): boolean {
  return (
    /^TRANSF\.?\s+INTERNET\s+A\s+OTRO\s+BANCOS?$/.test(key) ||
    /^TRANSF\.?\s*INTERNET\s+A\s+3O?\s+MISMO\s+BCO$/.test(key) ||
    /^TRANSFERENCIA\s+INTERNET\s+A\s+OTRO\s+BANCOS?$/.test(key) ||
    /^TRANSFERENCIA\s+A\s+3RO?\s+MISMO\s+BANCO$/.test(key) ||
    /^TRANSFERENCIA\s+INTERNET\s+A\s+3RO?\s+MISMO\s+BANCO$/.test(key) ||
    /CARGO\s+MERCADO\s+CAPITALES/.test(key)
  );
}

/** Generic bank transfer or other template merchants — used for Único backfill only. */
export function isGenericTransferMerchantKey(merchantKey: string): boolean {
  const key = merchantKey.trim();
  if (!key) return false;
  if (isCcTraspasoDeudaMerchant(key)) return true;
  if (isExactGenericUniqueMerchantKey(key)) return true;
  if (/^(TRANSFERENCIA|TRANSF)$/.test(key)) return true;
  if (matchesKnownGenericTransferTemplate(key)) return true;

  const m = key.match(/^(TRANSFERENCIA|TRANSF)\.?\s+(.+)$/);
  if (!m) return false;
  const tail = m[2]!.trim();
  if (!tail) return true;
  if (/\d{3,}/.test(tail)) return false;

  for (const raw of tail.split(/\s+/)) {
    const token = raw.replace(/[^A-ZÁÉÍÓÚÑ0-9]/gi, "").toUpperCase();
    if (!token || token.length < 3) continue;
    if (GENERIC_TRANSFER_BOILERPLATE.has(token)) continue;
    return false;
  }
  return true;
}

/** Mix hex toward black (e.g. 0.22 ≈ `color-mix(in srgb, color 78%, black)`). */
export function darkenHexColor(hex: string, mixTowardBlack = 0.22): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1]!;
  const r0 = parseInt(h.slice(0, 2), 16);
  const g0 = parseInt(h.slice(2, 4), 16);
  const b0 = parseInt(h.slice(4, 6), 16);
  const k = 1 - Math.min(1, Math.max(0, mixTowardBlack));
  const r = Math.round(r0 * k);
  const g = Math.round(g0 * k);
  const b = Math.round(b0 * k);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function enrichCcExpenseCategoryChartColors(
  rows: readonly CcExpenseCategoryRow[]
): CcExpenseCategoryRow[] {
  const bills = rows.find((r) => r.slug === BILLS_CC_EXPENSE_SLUG);
  if (!bills) return [...rows];
  const amortColor = darkenHexColor(bills.chart_color);
  return rows.map((r) =>
    r.slug === REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG
      ? { ...r, chart_color: amortColor }
      : r
  );
}

export function listCcExpenseCategories(): CcExpenseCategoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, slug, label, label_i18n_key, sort_order, chart_color
       FROM cc_expense_categories
       ORDER BY sort_order, id`
    )
    .all() as CcExpenseCategoryRow[];
  return enrichCcExpenseCategoryChartColors(rows);
}

export function getCcExpenseCategoryBySlug(slug: string): CcExpenseCategoryRow | null {
  const row = db
    .prepare(
      `SELECT id, slug, label, label_i18n_key, sort_order, chart_color
       FROM cc_expense_categories WHERE slug = ?`
    )
    .get(slug) as CcExpenseCategoryRow | undefined;
  return row ?? null;
}

export function loadCcExpenseCategoryMaps(accountIds: readonly number[]): {
  lineOverrides: Map<number, string>;
  merchantRules: Map<string, string>;
  /** `account_id|purchase_key` → category slug (assigned Único only). */
  uniquePurchases: Map<string, string>;
  /** Único with no category — blocks merchant rules for this purchase. */
  uniquePurchaseModeKeys: Set<string>;
} {
  const lineOverrides = new Map<number, string>();
  const merchantRules = new Map<string, string>();
  const uniquePurchases = new Map<string, string>();
  const uniquePurchaseModeKeys = new Set<string>();

  if (accountIds.length === 0) {
    return { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys };
  }

  const ph = accountIds.map(() => "?").join(",");
  const lineRows = db
    .prepare(
      `SELECT lc.statement_line_id, c.slug
       FROM cc_expense_line_categories lc
       JOIN cc_expense_categories c ON c.id = lc.category_id
       JOIN cc_statement_lines l ON l.id = lc.statement_line_id
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id IN (${ph})`
    )
    .all(...accountIds) as { statement_line_id: number; slug: string }[];

  for (const r of lineRows) {
    lineOverrides.set(r.statement_line_id, r.slug);
  }

  const merchantRows = db
    .prepare(
      `SELECT mc.account_id, mc.merchant_key, c.slug
       FROM cc_expense_merchant_categories mc
       JOIN cc_expense_categories c ON c.id = mc.category_id
       WHERE mc.account_id IN (${ph})`
    )
    .all(...accountIds) as { account_id: number; merchant_key: string; slug: string }[];

  for (const r of merchantRows) {
    merchantRules.set(`${r.account_id}|${r.merchant_key}`, r.slug);
  }

  const uniqueRows = db
    .prepare(
      `SELECT up.account_id, up.purchase_key, c.slug
       FROM cc_expense_unique_purchases up
       LEFT JOIN cc_expense_categories c ON c.id = up.category_id
       WHERE up.account_id IN (${ph})`
    )
    .all(...accountIds) as {
    account_id: number;
    purchase_key: string;
    slug: string | null;
  }[];

  for (const r of uniqueRows) {
    const mapKey = `${r.account_id}|${r.purchase_key}`;
    if (r.slug == null) {
      uniquePurchaseModeKeys.add(mapKey);
    } else {
      uniquePurchases.set(mapKey, r.slug);
    }
  }

  return { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys };
}

export function resolveCcExpensePurchaseKey(statementLineId: number): string {
  const ctx = loadCcStatementLineExpenseCtx(statementLineId);
  if (!ctx) return `line-fallback:missing:${statementLineId}`;
  return stableCcExpensePurchaseKeyFromCtx(ctx);
}

function uniquePurchaseMapKey(accountId: number, purchaseKey: string): string {
  return `${accountId}|${purchaseKey}`;
}

/** Merchant rule for this account: exact normalized `merchant_key` match only. */
export function resolveMerchantCategorySlug(
  accountId: number,
  merchantKey: string,
  merchantRules: Map<string, string>
): string | null {
  if (!merchantKey) return null;
  return merchantRules.get(`${accountId}|${merchantKey}`) ?? null;
}

/** Stored merchant rule keys equal to `merchantKey` (exact match). */
export function merchantRuleKeysMatchingLineMerchant(
  accountId: number,
  merchantKey: string
): string[] {
  if (!merchantKey) return [];
  const row = db
    .prepare(
      `SELECT merchant_key FROM cc_expense_merchant_categories
       WHERE account_id = ? AND merchant_key = ?`
    )
    .get(accountId, merchantKey) as { merchant_key: string } | undefined;
  return row ? [row.merchant_key] : [];
}

function uniquePurchaseModeKeysForResolve(
  accountId: number,
  statementLineId: number,
  purchaseKey: string,
  uniquePurchaseModeKeys?: Set<string>
): string[] {
  if (!uniquePurchaseModeKeys || uniquePurchaseModeKeys.size === 0) return [];
  const keys = [uniquePurchaseMapKey(accountId, purchaseKey)];
  if (purchaseKey.startsWith("checking-cartola:")) {
    const portion: "gastos" | "deposit" = purchaseKey.endsWith(":deposit")
      ? "deposit"
      : "gastos";
    keys.push(
      uniquePurchaseMapKey(
        accountId,
        legacyCheckingGastosPurchaseKey(statementLineId, portion)
      )
    );
  }
  return keys;
}

export function resolveCcExpenseCategorySlug(opts: {
  statementLineId: number;
  accountId: number;
  merchantKey: string;
  purchaseKey: string;
  lineOverrides: Map<number, string>;
  merchantRules: Map<string, string>;
  uniquePurchases: Map<string, string>;
  uniquePurchaseModeKeys?: Set<string>;
}): string {
  const uniqueKey = uniquePurchaseMapKey(opts.accountId, opts.purchaseKey);
  let uniqueSlug = opts.uniquePurchases.get(uniqueKey);
  if (uniqueSlug == null) {
    const legacyKey = legacyInstallmentHPurchaseKey(opts.purchaseKey);
    if (legacyKey) {
      uniqueSlug =
        opts.uniquePurchases.get(uniquePurchaseMapKey(opts.accountId, legacyKey)) ?? undefined;
    }
  }
  if (uniqueSlug == null && opts.purchaseKey.startsWith("checking-cartola:")) {
    const portion: "gastos" | "deposit" = opts.purchaseKey.endsWith(":deposit")
      ? "deposit"
      : "gastos";
    const legacyKey = uniquePurchaseMapKey(
      opts.accountId,
      legacyCheckingGastosPurchaseKey(opts.statementLineId, portion)
    );
    uniqueSlug = opts.uniquePurchases.get(legacyKey) ?? undefined;
  }
  if (uniqueSlug != null) return uniqueSlug;

  if (
    uniquePurchaseModeKeysForResolve(
      opts.accountId,
      opts.statementLineId,
      opts.purchaseKey,
      opts.uniquePurchaseModeKeys
    ).some((key) => opts.uniquePurchaseModeKeys?.has(key))
  ) {
    return UNCLASSIFIED_CC_EXPENSE_SLUG;
  }

  const lineSlug = opts.lineOverrides.get(opts.statementLineId);
  if (lineSlug) return lineSlug;

  if (isCcTraspasoDeudaMerchant(opts.merchantKey)) {
    return NO_CUENTA_CC_EXPENSE_SLUG;
  }

  if (!isGenericTransferMerchantKey(opts.merchantKey)) {
    const merchantSlug = resolveMerchantCategorySlug(
      opts.accountId,
      opts.merchantKey,
      opts.merchantRules
    );
    if (merchantSlug) return merchantSlug;
  }

  if (isCancelledInstallmentPurchaseKey(opts.accountId, opts.purchaseKey)) {
    return NO_CUENTA_CC_EXPENSE_SLUG;
  }

  return UNCLASSIFIED_CC_EXPENSE_SLUG;
}

function resolveInstallmentPurchaseIdsFromKey(
  accountId: number,
  purchaseKey: string
): number[] {
  if (purchaseKey.startsWith("installment:")) {
    const purchaseId = Number(purchaseKey.slice("installment:".length));
    return Number.isFinite(purchaseId) ? [purchaseId] : [];
  }
  if (purchaseKey.startsWith("installment-pr:")) {
    const parserRowId = purchaseKey.slice("installment-pr:".length);
    const hits = db
      .prepare(
        `SELECT DISTINCT purchase_id FROM cc_installment_payments WHERE parser_row_id = ?`
      )
      .all(parserRowId) as { purchase_id: number }[];
    return hits.map((h) => h.purchase_id);
  }
  const parsed = parseInstallmentHPurchaseKey(purchaseKey);
  if (parsed) {
    const rows = db
      .prepare(
        `SELECT id, merchant, total_amount_clp FROM cc_installment_purchases
         WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ?`
      )
      .all(accountId, parsed.purchaseIso, parsed.nroTotal) as {
      id: number;
      merchant: string | null;
      total_amount_clp: number;
    }[];
    return rows
      .filter((r) => normalizeCcExpenseMerchantKey(r.merchant) === parsed.merchantKey)
      // When the key carries a total, disambiguate same-identity purchases by amount.
      .filter((r) => parsed.totalClp == null || Math.round(r.total_amount_clp) === parsed.totalClp)
      .map((r) => r.id);
  }
  return [];
}

function isCancelledInstallmentPurchaseKey(accountId: number, purchaseKey: string): boolean {
  const purchaseIds = resolveInstallmentPurchaseIdsFromKey(accountId, purchaseKey);
  if (purchaseIds.length === 0) return false;
  const cancelled = cancelledInstallmentPurchaseIdsForAccount(accountId);
  return purchaseIds.some((id) => cancelled.has(id));
}

export function lineHasUniquePurchaseMode(
  accountId: number,
  purchaseKey: string,
  uniquePurchases: Map<string, string>,
  uniquePurchaseModeKeys?: Set<string>
): boolean {
  const key = uniquePurchaseMapKey(accountId, purchaseKey);
  return (
    uniquePurchases.has(key) ||
    (uniquePurchaseModeKeys?.has(key) ?? false)
  );
}

/** Único from persisted row or generic transfer / Mercado Capitales template merchants. */
export function categoryUniqueForExpenseLine(
  accountId: number,
  purchaseKey: string,
  merchantKey: string,
  uniquePurchases: Map<string, string>,
  uniquePurchaseModeKeys?: Set<string>
): boolean {
  if (
    lineHasUniquePurchaseMode(
      accountId,
      purchaseKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    )
  ) {
    return true;
  }
  return isGenericTransferMerchantKey(merchantKey);
}

/**
 * Persist Único row for generic merchants (idempotent). Keeps merchant rules from
 * applying comercio-wide after cartola imports that post-date the one-time migration backfill.
 */
export function ensureGenericUniquePurchaseRow(
  accountId: number,
  purchaseKey: string,
  merchantKey: string,
  opts?: { statementLineId?: number; categoryId?: number | null }
): boolean {
  if (!isGenericTransferMerchantKey(merchantKey)) return false;
  // Traspaso-deuda lines resolve to no_cuenta via the derived branch in
  // resolveCcExpenseCategorySlug; an auto-created NULL-category row here would put the
  // purchase in Único-sin-categoría mode, which short-circuits resolution to
  // «Sin clasificar» before that branch. Only an explicit user clear may write that row.
  if (isCcTraspasoDeudaMerchant(merchantKey)) return false;
  const exists = db
    .prepare(
      `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, purchaseKey) as { o: number } | undefined;
  if (exists) return false;

  let categoryId: number | null = opts?.categoryId ?? null;
  if (categoryId == null && opts?.statementLineId != null) {
    const lc = db
      .prepare(
        `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
      )
      .get(opts.statementLineId) as { category_id: number } | undefined;
    categoryId = lc?.category_id ?? null;
  }

  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
         VALUES (?, ?, ?)`
      )
      .run(accountId, purchaseKey, categoryId).changes > 0
  );
}

/** Persist + register Único mode for generic merchants (same request + DB). */
export function registerGenericUniquePurchaseMode(
  accountId: number,
  purchaseKey: string,
  merchantKey: string,
  uniquePurchaseModeKeys: Set<string>,
  opts?: { statementLineId?: number; categoryId?: number | null }
): void {
  if (!isGenericTransferMerchantKey(merchantKey)) return;
  // Traspaso-deuda: never enter Único-sin-categoría mode — see ensureGenericUniquePurchaseRow.
  if (isCcTraspasoDeudaMerchant(merchantKey)) return;
  ensureGenericUniquePurchaseRow(accountId, purchaseKey, merchantKey, opts);
  uniquePurchaseModeKeys.add(uniquePurchaseMapKey(accountId, purchaseKey));
}

/** Persist + register Único for auto deposit-match lines (any merchant key). */
export function registerUniquePurchaseMode(
  accountId: number,
  purchaseKey: string,
  categoryId: number | null,
  uniquePurchaseModeKeys: Set<string>
): void {
  db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  ).run(accountId, purchaseKey, categoryId);
  uniquePurchaseModeKeys.add(uniquePurchaseMapKey(accountId, purchaseKey));
}

export type CcStatementLineExpenseCtx = {
  account_id: number;
  installment_flag: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  /** Ledger `total_amount_clp` for the installment purchase (disambiguates same-identity purchases). */
  installment_total_clp: number | null;
  parser_row_id: string | null;
};

/**
 * Canonical `installment-h:` key. Includes the ledger total so two purchases that share
 * account/date/cuotas/merchant but differ by amount get distinct keys. When the total is absent it
 * emits the legacy (no-total) key, which read paths still resolve via
 * {@link legacyInstallmentHPurchaseKey}. Keep in sync with the parsers in this file.
 */
export function stableInstallmentHPurchaseKeyFromLedgerArgs(opts: {
  accountId: number;
  purchaseDateIso: string;
  cuotasTotales: number;
  totalAmountClp?: number | null;
  merchant: string | null | undefined;
}): string | null {
  const merchantKey = normalizeCcExpenseMerchantKey(opts.merchant);
  if (!opts.purchaseDateIso || !merchantKey || opts.cuotasTotales <= 0) return null;
  const total = opts.totalAmountClp;
  if (total != null && Number.isFinite(total)) {
    return `installment-h:${opts.accountId}:${opts.purchaseDateIso}:${opts.cuotasTotales}:${Math.round(total)}:${merchantKey}`;
  }
  return `installment-h:${opts.accountId}:${opts.purchaseDateIso}:${opts.cuotasTotales}:${merchantKey}`;
}

/**
 * Legacy (pre-amount) form of a new `installment-h:` key — drops the total segment. Returns null
 * when the key is already legacy (or not an installment-h key). Used for read fallback so category /
 * notes / big-group rows stored before the amount was added keep resolving.
 */
export function legacyInstallmentHPurchaseKey(purchaseKey: string): string | null {
  if (!purchaseKey.startsWith("installment-h:")) return null;
  const parts = purchaseKey.split(":");
  // New: installment-h:acct:iso:cuotaTotal:total:merchant...  (total is a pure integer at index 4)
  if (parts.length < 6 || !/^\d+$/.test(parts[4] ?? "")) return null;
  return [parts[0], parts[1], parts[2], parts[3], ...parts.slice(5)].join(":");
}

/** Parse an `installment-h:` key (new-with-total or legacy). `totalClp` is null for legacy keys. */
export function parseInstallmentHPurchaseKey(purchaseKey: string): {
  accountId: number;
  purchaseIso: string;
  nroTotal: number;
  totalClp: number | null;
  merchantKey: string;
} | null {
  if (!purchaseKey.startsWith("installment-h:")) return null;
  const parts = purchaseKey.split(":");
  if (parts.length < 5) return null;
  const accountId = Number(parts[1]);
  const purchaseIso = parts[2] ?? "";
  const nroTotal = Number(parts[3]);
  const hasTotal = parts.length >= 6 && /^\d+$/.test(parts[4] ?? "");
  const totalClp = hasTotal ? Number(parts[4]) : null;
  const merchantKey = hasTotal ? parts.slice(5).join(":") : parts.slice(4).join(":");
  if (!Number.isFinite(accountId) || !purchaseIso || !Number.isFinite(nroTotal) || !merchantKey) {
    return null;
  }
  return { accountId, purchaseIso, nroTotal, totalClp, merchantKey };
}

/** Stable across PDF reimports (uses parser_row_id / installment-h, not DB line id). */
export function stableCcExpensePurchaseKeyFromCtx(ctx: CcStatementLineExpenseCtx): string {
  if (ctx.installment_flag === 1) {
    const purchaseIso = purchaseDateIsoFromLine(ctx);
    if (purchaseIso && ctx.nro_cuota_total != null && ctx.nro_cuota_total > 0) {
      const hKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId: ctx.account_id,
        purchaseDateIso: purchaseIso,
        cuotasTotales: ctx.nro_cuota_total,
        totalAmountClp: ctx.installment_total_clp,
        merchant: ctx.merchant,
      });
      if (hKey) return hKey;
    }
    const parserRowId = String(ctx.parser_row_id ?? "").trim();
    if (parserRowId && !parserRowId.startsWith("synthetic:")) {
      return `installment-pr:${parserRowId}`;
    }
  }
  const parserRowId = String(ctx.parser_row_id ?? "").trim();
  if (parserRowId && !parserRowId.startsWith("synthetic:")) {
    return `line-pr:${parserRowId}`;
  }
  const merch = normalizeCcExpenseMerchantKey(ctx.merchant);
  const iso = purchaseDateIsoFromLine(ctx) ?? "";
  return `line-fallback:${ctx.account_id}:${merch}:${iso}`;
}

function purchaseDateIsoFromLine(ctx: CcStatementLineExpenseCtx): string | null {
  return (
    parseDdMmYyToIso(ctx.transaction_date ?? "") ??
    parseDdMmYyToIso(ctx.posting_date ?? "")
  );
}

function cuotaAmountMatches(a: number | null, b: number | null): boolean {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return a === b;
  }
  const tol = Math.max(500, Math.round(0.02 * a));
  return Math.abs(a - b) <= tol;
}

export function loadCcStatementLineExpenseCtx(statementLineId: number): CcStatementLineExpenseCtx | null {
  const row = db
    .prepare(
      `SELECT s.account_id, l.installment_flag, l.merchant, l.transaction_date, l.posting_date,
              l.nro_cuota_total, l.valor_cuota_mensual_clp, l.parser_row_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.id = ?`
    )
    .get(statementLineId) as Omit<CcStatementLineExpenseCtx, "installment_total_clp"> | undefined;
  if (!row) return null;
  return { ...row, installment_total_clp: installmentLedgerTotalForCtx(row) };
}

/**
 * Ledger `total_amount_clp` for an installment statement line, matched by identity
 * (account/date/cuotas/merchant). Returns null unless exactly one ledger purchase matches (so a
 * rare same-identity collision falls back to the legacy no-total key rather than guessing).
 */
function installmentLedgerTotalForCtx(
  ctx: Omit<CcStatementLineExpenseCtx, "installment_total_clp">
): number | null {
  if (ctx.installment_flag !== 1 || ctx.nro_cuota_total == null || ctx.nro_cuota_total <= 0) {
    return null;
  }
  const iso = parseDdMmYyToIso(ctx.transaction_date ?? "") ?? parseDdMmYyToIso(ctx.posting_date ?? "");
  if (!iso) return null;
  return installmentLedgerTotalForIdentity(ctx.account_id, iso, ctx.nro_cuota_total, ctx.merchant);
}

/**
 * Ledger `total_amount_clp` for an installment identity (account/date/cuotas/merchant), or null
 * unless exactly one ledger purchase matches (so same-identity collisions fall back to the legacy
 * no-total key). Used to stamp `installment_total_clp` on statement cuota lines.
 */
export function installmentLedgerTotalForIdentity(
  accountId: number,
  purchaseDateIso: string,
  cuotasTotales: number,
  merchant: string | null | undefined
): number | null {
  const merchantKey = normalizeCcExpenseMerchantKey(merchant);
  if (!purchaseDateIso || !merchantKey || cuotasTotales <= 0) return null;
  const rows = db
    .prepare(
      `SELECT total_amount_clp, merchant FROM cc_installment_purchases
       WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ?`
    )
    .all(accountId, purchaseDateIso, cuotasTotales) as {
    total_amount_clp: number;
    merchant: string | null;
  }[];
  const matches = rows.filter((r) => normalizeCcExpenseMerchantKey(r.merchant) === merchantKey);
  return matches.length === 1 ? Math.round(matches[0]!.total_amount_clp) : null;
}

/** Statement line ids that share one installment purchase (cuotas 1..N). */
export function listInstallmentPurchaseSiblingStatementLineIds(statementLineId: number): number[] {
  const ctx = loadCcStatementLineExpenseCtx(statementLineId);
  if (!ctx || ctx.installment_flag !== 1) return [statementLineId];

  const viaLedger = listInstallmentSiblingIdsViaLedger(ctx);
  if (viaLedger.length > 0) return viaLedger;

  const viaHeuristic = listInstallmentSiblingIdsViaHeuristic(ctx);
  return viaHeuristic.length > 0 ? viaHeuristic : [statementLineId];
}

function listInstallmentSiblingIdsViaLedger(ctx: CcStatementLineExpenseCtx): number[] {
  const parserRowId = String(ctx.parser_row_id ?? "").trim();
  if (!parserRowId || parserRowId.startsWith("synthetic:")) return [];

  const pay = db
    .prepare(`SELECT purchase_id FROM cc_installment_payments WHERE parser_row_id = ?`)
    .get(parserRowId) as { purchase_id: number } | undefined;
  if (!pay) return [];

  const parserRows = db
    .prepare(
      `SELECT parser_row_id FROM cc_installment_payments
       WHERE purchase_id = ?
         AND parser_row_id IS NOT NULL
         AND parser_row_id NOT LIKE 'synthetic:%'`
    )
    .all(pay.purchase_id) as { parser_row_id: string }[];
  if (parserRows.length === 0) return [];

  const ids = new Set<number>();
  const selOne = db.prepare(
    `SELECT l.id FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.account_id = ? AND l.parser_row_id = ?`
  );
  for (const { parser_row_id } of parserRows) {
    const hit = selOne.get(ctx.account_id, parser_row_id) as { id: number } | undefined;
    if (hit) ids.add(hit.id);
  }
  return [...ids].sort((a, b) => a - b);
}

function listInstallmentSiblingIdsViaHeuristic(ctx: CcStatementLineExpenseCtx): number[] {
  const purchaseIso = purchaseDateIsoFromLine(ctx);
  const merchantKey = normalizeCcExpenseMerchantKey(ctx.merchant);
  const cuotasTotal = ctx.nro_cuota_total;
  if (!purchaseIso || !merchantKey || cuotasTotal == null || cuotasTotal <= 0) return [];

  const candidates = db
    .prepare(
      `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.valor_cuota_mensual_clp
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.installment_flag = 1 AND l.nro_cuota_total = ?`
    )
    .all(ctx.account_id, cuotasTotal) as {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    valor_cuota_mensual_clp: number | null;
  }[];

  const anchorCuota = ctx.valor_cuota_mensual_clp;
  const out: number[] = [];
  for (const row of candidates) {
    if (normalizeCcExpenseMerchantKey(row.merchant) !== merchantKey) continue;
    const rowCtx: CcStatementLineExpenseCtx = {
      account_id: ctx.account_id,
      installment_flag: 1,
      merchant: row.merchant,
      transaction_date: row.transaction_date,
      posting_date: row.posting_date,
      nro_cuota_total: cuotasTotal,
      valor_cuota_mensual_clp: row.valor_cuota_mensual_clp,
      installment_total_clp: null,
      parser_row_id: null,
    };
    if (purchaseDateIsoFromLine(rowCtx) !== purchaseIso) continue;
    if (!cuotaAmountMatches(anchorCuota, row.valor_cuota_mensual_clp)) continue;
    out.push(row.id);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Statement line ids for an `installment-h:` purchase key (manual ledger contract).
 * When `applyCuotaAmountFilter` is true, `anchorCuotaClp` disambiguates same-day contracts (statement anchor).
 */
function listInstallmentHHeuristicStatementLineIds(
  accountId: number,
  purchaseIso: string,
  nroTotal: number,
  merchantKey: string,
  anchorCuotaClp: number | null | undefined,
  applyCuotaAmountFilter: boolean
): number[] {
  const heuristicCtx: CcStatementLineExpenseCtx = {
    account_id: accountId,
    installment_flag: 1,
    merchant: merchantKey,
    transaction_date: null,
    posting_date: null,
    nro_cuota_total: nroTotal,
    valor_cuota_mensual_clp:
      anchorCuotaClp != null && Number.isFinite(anchorCuotaClp) ? anchorCuotaClp : null,
    installment_total_clp: null,
    parser_row_id: null,
  };
  const candidates = db
    .prepare(
      `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.valor_cuota_mensual_clp
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.installment_flag = 1 AND l.nro_cuota_total = ?`
    )
    .all(accountId, nroTotal) as {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    valor_cuota_mensual_clp: number | null;
  }[];
  const out: number[] = [];
  for (const row of candidates) {
    if (normalizeCcExpenseMerchantKey(row.merchant) !== merchantKey) continue;
    const rowCtx: CcStatementLineExpenseCtx = {
      ...heuristicCtx,
      merchant: row.merchant,
      transaction_date: row.transaction_date,
      posting_date: row.posting_date,
      valor_cuota_mensual_clp: row.valor_cuota_mensual_clp,
    };
    if (purchaseDateIsoFromLine(rowCtx) !== purchaseIso) continue;
    if (
      applyCuotaAmountFilter &&
      !cuotaAmountMatches(heuristicCtx.valor_cuota_mensual_clp, row.valor_cuota_mensual_clp)
    ) {
      continue;
    }
    out.push(row.id);
  }
  return out.sort((a, b) => a - b);
}

/** All statement lines for one logical purchase (installment contract or single charge). */
export function listStatementLineIdsForPurchaseKey(
  statementLineId: number,
  purchaseKey?: string
): number[] {
  const key = purchaseKey ?? resolveCcExpensePurchaseKey(statementLineId);
  const ctx = loadCcStatementLineExpenseCtx(statementLineId);
  if (!ctx) return [statementLineId];

  if (key.startsWith("installment:")) {
    const purchaseId = Number(key.slice("installment:".length));
    if (!Number.isFinite(purchaseId)) return [statementLineId];
    const parserRows = db
      .prepare(
        `SELECT parser_row_id FROM cc_installment_payments
         WHERE purchase_id = ?
           AND parser_row_id IS NOT NULL
           AND parser_row_id NOT LIKE 'synthetic:%'`
      )
      .all(purchaseId) as { parser_row_id: string }[];
    const ids = new Set<number>();
    const selOne = db.prepare(
      `SELECT l.id FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.parser_row_id = ?`
    );
    for (const { parser_row_id } of parserRows) {
      const hit = selOne.get(ctx.account_id, parser_row_id) as { id: number } | undefined;
      if (hit) ids.add(hit.id);
    }
    const out = [...ids].sort((a, b) => a - b);
    return out.length > 0 ? out : [statementLineId];
  }

  const parsedH = parseInstallmentHPurchaseKey(key);
  if (parsedH) {
    const cuotaClp = ctx.valor_cuota_mensual_clp;
    const out = listInstallmentHHeuristicStatementLineIds(
      parsedH.accountId,
      parsedH.purchaseIso,
      parsedH.nroTotal,
      parsedH.merchantKey,
      Number.isFinite(cuotaClp as number) ? (cuotaClp as number) : null,
      true
    );
    if (out.length > 0) return out;
    return listInstallmentPurchaseSiblingStatementLineIds(statementLineId);
  }

  if (key.startsWith("line-pr:")) {
    const parserRowId = key.slice("line-pr:".length);
    const hit = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.parser_row_id = ?`
      )
      .get(ctx.account_id, parserRowId) as { id: number } | undefined;
    return hit ? [hit.id] : [statementLineId];
  }

  if (key.startsWith("installment-pr:")) {
    const parserRowId = key.slice("installment-pr:".length);
    const siblings = listInstallmentSiblingIdsViaLedger({
      ...ctx,
      parser_row_id: parserRowId,
    });
    if (siblings.length > 0) return siblings;
    return [statementLineId];
  }

  if (key.startsWith("line:")) {
    const id = Number(key.slice("line:".length));
    return Number.isFinite(id) && id > 0 ? [id] : [statementLineId];
  }

  return [statementLineId];
}

export function ccStatementLineBelongsToCreditCardGroup(statementLineId: number): {
  ok: boolean;
  account_id?: number;
  merchant?: string | null;
} {
  const allowed = new Set(listCreditCardMasterAccountIds());
  const row = db
    .prepare(
      `SELECT s.account_id, l.merchant
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.id = ?`
    )
    .get(statementLineId) as { account_id: number; merchant: string | null } | undefined;

  if (!row || !allowed.has(row.account_id)) {
    return { ok: false };
  }
  return { ok: true, account_id: row.account_id, merchant: row.merchant };
}

function executeCcExpenseCategoryAssignment(opts: {
  accountId: number;
  merchantKey: string;
  purchaseKey: string;
  purchaseLineIds: number[];
  unique: boolean;
  clearCategory: boolean;
  hasCategory: boolean;
  catId: number | null;
  resolvedSlug: string;
}): {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
} {
  const {
    accountId,
    merchantKey,
    purchaseKey,
    purchaseLineIds,
    unique,
    clearCategory,
    catId,
    resolvedSlug,
  } = opts;

  const delLine = db.prepare(`DELETE FROM cc_expense_line_categories WHERE statement_line_id = ?`);
  const delUniquePurchase = db.prepare(
    `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
  );
  const upsertUniquePurchase = db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  );
  const upsertMerchant = db.prepare(
    `INSERT INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, merchant_key) DO UPDATE SET category_id = excluded.category_id`
  );
  const delMerchant = db.prepare(
    `DELETE FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`
  );

  const tx = db.transaction(() => {
    for (const lineId of purchaseLineIds) {
      delLine.run(lineId);
    }

    if (clearCategory) {
      if (unique) {
        upsertUniquePurchase.run(accountId, purchaseKey, null);
        // The resolver falls back to the legacy installment-h key (no amount segment)
        // when the current key has no category — a populated legacy row would shadow
        // this clear and the contract would keep its old category. Mirror the clear
        // onto an existing legacy row (never create one).
        const legacyKey = legacyInstallmentHPurchaseKey(purchaseKey);
        if (
          legacyKey &&
          db
            .prepare(
              `SELECT 1 FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
            )
            .get(accountId, legacyKey)
        ) {
          upsertUniquePurchase.run(accountId, legacyKey, null);
        }
      } else {
        delUniquePurchase.run(accountId, purchaseKey);
        for (const ruleKey of merchantRuleKeysMatchingLineMerchant(accountId, merchantKey)) {
          delMerchant.run(accountId, ruleKey);
        }
        if (!isInstallmentContractPurchaseKey(purchaseKey)) {
          markUserDeclinedAutoCategory(accountId, purchaseKey);
        }
      }
      return;
    }

    clearUserDeclinedAutoCategory(accountId, purchaseKey);

    if (unique) {
      delUniquePurchase.run(accountId, purchaseKey);
      upsertUniquePurchase.run(accountId, purchaseKey, catId);
    } else {
      delUniquePurchase.run(accountId, purchaseKey);
      if (catId != null && merchantKey) {
        upsertMerchant.run(accountId, merchantKey, catId);
      }
    }
  });
  tx();

  if (clearCategory) {
    return {
      category_slug: UNCLASSIFIED_CC_EXPENSE_SLUG,
      unique,
      merchant_key: merchantKey,
      purchase_key: purchaseKey,
    };
  }

  return {
    category_slug: resolvedSlug,
    unique,
    merchant_key: merchantKey,
    purchase_key: purchaseKey,
  };
}

function statementLineIdsForManualInstallmentHPurchaseKey(purchaseKey: string): number[] {
  const parsed = parseInstallmentHPurchaseKey(purchaseKey);
  if (!parsed) return [];
  const { accountId, purchaseIso, nroTotal, merchantKey } = parsed;
  return listInstallmentHHeuristicStatementLineIds(
    accountId,
    purchaseIso,
    nroTotal,
    merchantKey,
    null,
    false
  );
}

/**
 * Synthetic consolidated installment rows use `statement_line_id = -cc_installment_purchases.id`.
 * Category PATCH uses that id; resolve the manual ledger purchase and apply the same rules as a real line.
 */
export function assignCcExpenseCategoryForManualLedgerInstallmentPurchase(opts: {
  purchaseId: number;
  unique: boolean;
  categorySlug?: string | null;
  clearCategory?: boolean;
}): {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
} {
  const pr = db
    .prepare(
      `SELECT id, account_id, purchase_date, cuotas_totales, total_amount_clp, merchant FROM cc_installment_purchases WHERE id = ?`
    )
    .get(opts.purchaseId) as
    | {
        id: number;
        account_id: number;
        purchase_date: string;
        cuotas_totales: number;
        total_amount_clp: number;
        merchant: string | null;
      }
    | undefined;
  if (!pr) {
    throw new Error("manual installment purchase not found");
  }

  const categorySlug = opts.categorySlug != null ? String(opts.categorySlug).trim() : "";
  const hasCategory = categorySlug.length > 0;
  const clearCategory = opts.clearCategory === true;

  if (hasCategory && categorySlug === UNCLASSIFIED_CC_EXPENSE_SLUG) {
    throw new Error("cannot assign unclassified category");
  }

  const allowed = new Set(listCreditCardMasterAccountIds());
  if (!allowed.has(pr.account_id)) {
    throw new Error("account is not in credit card group");
  }

  const merchantKey = normalizeCcExpenseMerchantKey(pr.merchant);
  if (!opts.unique && hasCategory && !merchantKey) {
    throw new Error("merchant required for comercio-wide category");
  }

  let catId: number | null = null;
  let resolvedSlug = UNCLASSIFIED_CC_EXPENSE_SLUG;
  if (hasCategory) {
    const cat = getCcExpenseCategoryBySlug(categorySlug);
    if (!cat) throw new Error("unknown category");
    catId = cat.id;
    resolvedSlug = cat.slug;
  }

  const purchaseIso = pr.purchase_date.length >= 10 ? pr.purchase_date.slice(0, 10) : pr.purchase_date;
  const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
    accountId: pr.account_id,
    purchaseDateIso: purchaseIso,
    cuotasTotales: pr.cuotas_totales,
    totalAmountClp: pr.total_amount_clp,
    merchant: pr.merchant,
  });
  if (!purchaseKey) {
    throw new Error("merchant and contract details required to classify manual installment");
  }

  const purchaseLineIds = statementLineIdsForManualInstallmentHPurchaseKey(purchaseKey);

  return executeCcExpenseCategoryAssignment({
    accountId: pr.account_id,
    merchantKey,
    purchaseKey,
    purchaseLineIds,
    unique: opts.unique,
    clearCategory,
    hasCategory,
    catId,
    resolvedSlug,
  });
}

export function assignCcExpenseLineCategory(opts: {
  statementLineId: number;
  unique: boolean;
  categorySlug?: string | null;
  /** User chose «Sin clasificar» — clear category; non-unique also removes merchant rule. */
  clearCategory?: boolean;
}): {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
} {
  const categorySlug = opts.categorySlug != null ? String(opts.categorySlug).trim() : "";
  const hasCategory = categorySlug.length > 0;

  if (hasCategory && categorySlug === UNCLASSIFIED_CC_EXPENSE_SLUG) {
    throw new Error("cannot assign unclassified category");
  }

  const belong = ccStatementLineBelongsToCreditCardGroup(opts.statementLineId);
  if (!belong.ok || belong.account_id == null) {
    throw new Error("statement line not in credit card group");
  }

  const merchantKey = normalizeCcExpenseMerchantKey(belong.merchant);
  if (!opts.unique && hasCategory && !merchantKey) {
    throw new Error("merchant required for comercio-wide category");
  }

  let catId: number | null = null;
  let resolvedSlug = UNCLASSIFIED_CC_EXPENSE_SLUG;
  if (hasCategory) {
    const cat = getCcExpenseCategoryBySlug(categorySlug);
    if (!cat) throw new Error("unknown category");
    catId = cat.id;
    resolvedSlug = cat.slug;
  }

  const purchaseKey = resolveCcExpensePurchaseKey(opts.statementLineId);
  const purchaseLineIds = listStatementLineIdsForPurchaseKey(
    opts.statementLineId,
    purchaseKey
  );

  return executeCcExpenseCategoryAssignment({
    accountId: belong.account_id,
    merchantKey,
    purchaseKey,
    purchaseLineIds,
    unique: opts.unique,
    clearCategory: opts.clearCategory === true,
    hasCategory,
    catId,
    resolvedSlug,
  });
}
