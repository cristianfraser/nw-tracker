import { db } from "./db.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";

/** Operational master account ids for flows (default: Santander credit_card_group). */
export function listCreditCardGroupOperationalAccountIds(
  creditCardGroupSlug = "santander"
): number[] {
  return listCreditCardGroupMasterAccountIds(creditCardGroupSlug);
}

/** Slug for `GET /api/flows/expenses/credit-card` (credit_card_groups, not liability_groups). */
export function primaryCreditCardExpensesGroupSlug(): string {
  return "santander";
}

export const UNCLASSIFIED_CC_EXPENSE_SLUG = "unclassified";

/** Excluded from gasto del mes, acumulado, chart stacks, and page total. */
export const NO_CUENTA_CC_EXPENSE_SLUG = "no_cuenta";

export function countsTowardCcExpenseTotals(categorySlug: string): boolean {
  return categorySlug !== NO_CUENTA_CC_EXPENSE_SLUG;
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

export function listCcExpenseCategories(): CcExpenseCategoryRow[] {
  return db
    .prepare(
      `SELECT id, slug, label, label_i18n_key, sort_order, chart_color
       FROM cc_expense_categories
       ORDER BY sort_order, id`
    )
    .all() as CcExpenseCategoryRow[];
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
  /** `account_id|purchase_key` → category slug, or null when Único without category yet. */
  uniquePurchases: Map<string, string | null>;
} {
  const lineOverrides = new Map<number, string>();
  const merchantRules = new Map<string, string>();
  const uniquePurchases = new Map<string, string | null>();

  if (accountIds.length === 0) {
    return { lineOverrides, merchantRules, uniquePurchases };
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
    uniquePurchases.set(`${r.account_id}|${r.purchase_key}`, r.slug);
  }

  return { lineOverrides, merchantRules, uniquePurchases };
}

export function resolveCcExpensePurchaseKey(statementLineId: number): string {
  const ctx = loadCcStatementLineExpenseCtx(statementLineId);
  if (!ctx) return `line-fallback:missing:${statementLineId}`;
  return stableCcExpensePurchaseKeyFromCtx(ctx);
}

function uniquePurchaseMapKey(accountId: number, purchaseKey: string): string {
  return `${accountId}|${purchaseKey}`;
}

export function resolveCcExpenseCategorySlug(opts: {
  statementLineId: number;
  accountId: number;
  merchantKey: string;
  purchaseKey: string;
  lineOverrides: Map<number, string>;
  merchantRules: Map<string, string>;
  uniquePurchases: Map<string, string | null>;
}): string {
  if (opts.uniquePurchases.has(uniquePurchaseMapKey(opts.accountId, opts.purchaseKey))) {
    const slug = opts.uniquePurchases.get(uniquePurchaseMapKey(opts.accountId, opts.purchaseKey));
    return slug ?? UNCLASSIFIED_CC_EXPENSE_SLUG;
  }

  const lineSlug = opts.lineOverrides.get(opts.statementLineId);
  if (lineSlug) return lineSlug;

  if (opts.merchantKey) {
    const merchantSlug = opts.merchantRules.get(`${opts.accountId}|${opts.merchantKey}`);
    if (merchantSlug) return merchantSlug;
  }

  return UNCLASSIFIED_CC_EXPENSE_SLUG;
}

export function lineHasUniquePurchaseMode(
  accountId: number,
  purchaseKey: string,
  uniquePurchases: Map<string, string | null>
): boolean {
  return uniquePurchases.has(uniquePurchaseMapKey(accountId, purchaseKey));
}

export type CcStatementLineExpenseCtx = {
  account_id: number;
  installment_flag: number;
  merchant: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  nro_cuota_total: number | null;
  valor_cuota_mensual_clp: number | null;
  parser_row_id: string | null;
};

/** Stable across PDF reimports (uses parser_row_id / installment-h, not DB line id). */
export function stableCcExpensePurchaseKeyFromCtx(ctx: CcStatementLineExpenseCtx): string {
  if (ctx.installment_flag === 1) {
    const purchaseIso = purchaseDateIsoFromLine(ctx);
    const merchantKey = normalizeCcExpenseMerchantKey(ctx.merchant);
    if (purchaseIso && merchantKey && ctx.nro_cuota_total != null && ctx.nro_cuota_total > 0) {
      return `installment-h:${ctx.account_id}:${purchaseIso}:${ctx.nro_cuota_total}:${merchantKey}`;
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
    .get(statementLineId) as CcStatementLineExpenseCtx | undefined;
  return row ?? null;
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
      parser_row_id: null,
    };
    if (purchaseDateIsoFromLine(rowCtx) !== purchaseIso) continue;
    if (!cuotaAmountMatches(anchorCuota, row.valor_cuota_mensual_clp)) continue;
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

  if (key.startsWith("installment-h:")) {
    const parts = key.split(":");
    if (parts.length >= 5) {
      const accountId = Number(parts[1]);
      const purchaseIso = parts[2]!;
      const nroTotal = Number(parts[3]);
      const merchantKey = parts[4]!;
      const cuotaClp = ctx.valor_cuota_mensual_clp;
      const heuristicCtx: CcStatementLineExpenseCtx = {
        account_id: accountId,
        installment_flag: 1,
        merchant: merchantKey,
        transaction_date: null,
        posting_date: null,
        nro_cuota_total: nroTotal,
        valor_cuota_mensual_clp: Number.isFinite(cuotaClp) ? cuotaClp : null,
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
        if (!cuotaAmountMatches(heuristicCtx.valor_cuota_mensual_clp, row.valor_cuota_mensual_clp)) {
          continue;
        }
        out.push(row.id);
      }
      if (out.length > 0) return out.sort((a, b) => a - b);
    }
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

/** @deprecated Use listStatementLineIdsForPurchaseKey */
export function listUniqueCategoryTargetStatementLineIds(statementLineId: number): number[] {
  return listStatementLineIdsForPurchaseKey(statementLineId);
}

export function ccStatementLineBelongsToCreditCardGroup(statementLineId: number): {
  ok: boolean;
  account_id?: number;
  merchant?: string | null;
} {
  const allowed = new Set(listCreditCardGroupOperationalAccountIds());
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

export function assignCcExpenseLineCategory(opts: {
  statementLineId: number;
  unique: boolean;
  categorySlug?: string | null;
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

  const tx = db.transaction(() => {
    for (const lineId of purchaseLineIds) {
      delLine.run(lineId);
    }

    if (opts.unique) {
      delUniquePurchase.run(belong.account_id, purchaseKey);
      upsertUniquePurchase.run(belong.account_id, purchaseKey, catId);
    } else {
      delUniquePurchase.run(belong.account_id, purchaseKey);
      if (catId != null && merchantKey) {
        upsertMerchant.run(belong.account_id, merchantKey, catId);
      }
    }
  });
  tx();

  return {
    category_slug: resolvedSlug,
    unique: opts.unique,
    merchant_key: merchantKey,
    purchase_key: purchaseKey,
  };
}
