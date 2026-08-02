import { db } from "./db.js";
import {
  legacyInstallmentHPurchaseKey,
  listInstallmentPurchaseSiblingStatementLineIds,
  loadCcStatementLineExpenseCtx,
  normalizeCcExpenseMerchantKey,
  stableCcExpensePurchaseKeyFromCtx,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import {
  merchantsMatchForCrossDedupe,
  purchaseAmountsMatch,
} from "./ccCrossImportDedupe.js";
import { isInstallmentContractSummaryMerchant } from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { statementKeyFromRow, type CcStatementCsvRecord } from "./ccStatementsImport.js";

const findStmtId = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

const listManualPurchases = db.prepare(
  `SELECT id, card_group, purchase_date, total_amount_clp, cuotas_totales, merchant
   FROM cc_installment_purchases
   WHERE account_id = ? AND source = 'manual'`
);

const listInstallmentLinesForStatement = db.prepare(
  `SELECT l.id, l.installment_flag, l.merchant, l.transaction_date, l.posting_date,
          l.nro_cuota_total, l.nro_cuota_current, l.amount_clp, l.valor_cuota_mensual_clp
   FROM cc_statement_lines l
   WHERE l.statement_id = ? AND l.installment_flag = 1`
);

const loadStatementMeta = db.prepare(
  `SELECT id, account_id, card_group, source_pdf, period_from, period_to
   FROM cc_statements WHERE id = ?`
);

const delManualPurchase = db.prepare(
  `DELETE FROM cc_installment_purchases WHERE id = ? AND account_id = ? AND source = 'manual'`
);

const delUniqueByKey = db.prepare(
  `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
);

// Purchase-key references that must follow the surviving PDF purchase when a manual twin is
// deleted (facturado-financing links, purchase notes, big-group assignments). UPDATE OR IGNORE
// + DELETE: when a row already exists under the PDF key, the PDF-side value wins and the stale
// manual-key row is dropped.
const updFinancingKey = db.prepare(
  `UPDATE OR IGNORE cc_facturado_financing_link_purchases SET financing_purchase_key = ?
   WHERE financing_account_id = ? AND financing_purchase_key = ?`
);
const delFinancingKey = db.prepare(
  `DELETE FROM cc_facturado_financing_link_purchases
   WHERE financing_account_id = ? AND financing_purchase_key = ?`
);
const updNoteKey = db.prepare(
  `UPDATE OR IGNORE cc_expense_purchase_notes SET purchase_key = ?
   WHERE account_id = ? AND purchase_key = ?`
);
const delNoteKey = db.prepare(
  `DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
);
const updBigGroupKey = db.prepare(
  `UPDATE OR IGNORE cc_expense_purchase_big_groups SET purchase_key = ?
   WHERE account_id = ? AND purchase_key = ?`
);
const delBigGroupKey = db.prepare(
  `DELETE FROM cc_expense_purchase_big_groups WHERE account_id = ? AND purchase_key = ?`
);

const findPdfPlansForLineIdentity = db.prepare(
  `SELECT id, source, purchase_date, total_amount_clp, cuotas_totales, merchant
   FROM cc_installment_purchases
   WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ? AND total_amount_clp = ?`
);

const convertManualPurchaseToPdf = db.prepare(
  `UPDATE cc_installment_purchases
   SET source = 'pdf', source_pdf_sample = COALESCE(source_pdf_sample, ?)
   WHERE id = ? AND account_id = ? AND source = 'manual'`
);

/**
 * True when a DISTINCT pdf-source plan matches the statement line's contract identity —
 * i.e. deleting the matched manual row leaves the contract represented in the ledger.
 * When the ledger merge fingerprint-matched the incoming PDF contract INTO the manual row
 * (identical merchant/date/amount, e.g. a nudged web-paste plan), no separate pdf plan
 * exists and the manual row IS the contract — it must be converted, never deleted.
 */
function separatePdfPlanExistsForLine(
  accountId: number,
  manualId: number,
  line: {
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    nro_cuota_total: number | null;
    amount_clp: number | null;
    valor_cuota_mensual_clp: number | null;
  }
): boolean {
  const lineIso = purchaseIsoFromLineFields(line.transaction_date, line.posting_date);
  const contractAmt = contractAmountClpFromLine(line);
  if (!lineIso || line.nro_cuota_total == null || line.nro_cuota_total <= 0 || contractAmt <= 0) {
    return false;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(line.merchant);
  return (
    findPdfPlansForLineIdentity.all(accountId, lineIso, line.nro_cuota_total, contractAmt) as {
      id: number;
      source: string;
      merchant: string | null;
    }[]
  ).some(
    (p) =>
      p.id !== manualId &&
      p.source === "pdf" &&
      normalizeCcExpenseMerchantKey(p.merchant) === merchantKey
  );
}

/**
 * Purchase key the surviving PDF side's gastos lines will carry. Prefer the ledger plan row
 * matched by the line's full identity + contract amount — plan-projected cuota lines build
 * their key from plan fields WITH the total, while a statement line's ctx key drops the total
 * on same-identity collisions (e.g. two same-day same-merchant contracts differing only in
 * amount), and the facturado-financing projection matches key strings exactly. Fall back to
 * the ctx key when no unique plan exists (statement lines with no ledger row).
 */
function pdfPurchaseKeyForMatchedLine(
  accountId: number,
  line: {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    nro_cuota_total: number | null;
    amount_clp: number | null;
    valor_cuota_mensual_clp: number | null;
  }
): string | null {
  const lineIso = purchaseIsoFromLineFields(line.transaction_date, line.posting_date);
  const contractAmt = contractAmountClpFromLine(line);
  if (lineIso && line.nro_cuota_total != null && line.nro_cuota_total > 0 && contractAmt > 0) {
    const merchantKey = normalizeCcExpenseMerchantKey(line.merchant);
    const plans = (
      findPdfPlansForLineIdentity.all(accountId, lineIso, line.nro_cuota_total, contractAmt) as {
        purchase_date: string;
        total_amount_clp: number;
        cuotas_totales: number;
        merchant: string | null;
      }[]
    ).filter((p) => normalizeCcExpenseMerchantKey(p.merchant) === merchantKey);
    if (plans.length === 1) {
      const plan = plans[0]!;
      const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId,
        purchaseDateIso: plan.purchase_date,
        cuotasTotales: plan.cuotas_totales,
        totalAmountClp: plan.total_amount_clp,
        merchant: plan.merchant,
      });
      if (key) return key;
    }
  }
  const ctx = loadCcStatementLineExpenseCtx(line.id);
  if (!ctx || ctx.account_id !== accountId) return null;
  return stableCcExpensePurchaseKeyFromCtx(ctx);
}

/** Repoint every purchase_key reference from the deleted manual's keys to the PDF key. */
function migrateManualPurchaseKeyRefs(
  accountId: number,
  manualKeys: readonly string[],
  pdfKey: string
): number {
  let rewritten = 0;
  for (const manualKey of manualKeys) {
    if (!manualKey || manualKey === pdfKey) continue;
    for (const [upd, del] of [
      [updFinancingKey, delFinancingKey],
      [updNoteKey, delNoteKey],
      [updBigGroupKey, delBigGroupKey],
    ] as const) {
      rewritten += upd.run(pdfKey, accountId, manualKey).changes;
      del.run(accountId, manualKey);
    }
  }
  return rewritten;
}

const selUniqueCat = db.prepare(
  `SELECT category_id FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
);

const insLineCat = db.prepare(
  `INSERT INTO cc_expense_line_categories (statement_line_id, category_id)
   VALUES (?, ?)
   ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
);

const upsertUniqueCat = db.prepare(
  `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
   VALUES (?, ?, ?)
   ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
);

function purchaseIsoFromLineFields(transaction_date: string | null, posting_date: string | null): string | null {
  return (
    parseDdMmYyToIso(String(transaction_date ?? "").trim()) ??
    parseDdMmYyToIso(String(posting_date ?? "").trim()) ??
    null
  );
}

function isIsoInInclusivePeriod(iso: string, periodFrom: string | null, periodTo: string | null): boolean {
  const fromIso =
    parseDdMmYyToIso(String(periodFrom ?? "").trim()) ??
    (/^\d{4}-\d{2}-\d{2}$/.test(String(periodFrom ?? "").trim())
      ? String(periodFrom).trim()
      : null);
  const toIso =
    parseDdMmYyToIso(String(periodTo ?? "").trim()) ??
    (/^\d{4}-\d{2}-\d{2}$/.test(String(periodTo ?? "").trim())
      ? String(periodTo).trim()
      : null);
  if (!fromIso || !toIso) return false;
  return iso >= fromIso && iso <= toIso;
}

function contractAmountClpFromLine(line: {
  amount_clp: number | null;
  valor_cuota_mensual_clp: number | null;
}): number {
  const a = Math.abs(line.amount_clp ?? 0);
  const v = Math.abs(line.valor_cuota_mensual_clp ?? 0);
  return Math.max(a, v);
}

function manualMatchesInstallmentLine(
  manual: {
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
  },
  line: {
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    nro_cuota_total: number | null;
    nro_cuota_current: number | null;
    amount_clp: number | null;
    valor_cuota_mensual_clp: number | null;
  }
): boolean {
  if (!merchantsMatchForCrossDedupe(manual.merchant, line.merchant)) return false;
  const lineNt = line.nro_cuota_total;
  if (lineNt != null && lineNt > 0 && manual.cuotas_totales !== lineNt) return false;
  const contractAmt = contractAmountClpFromLine(line);
  if (!purchaseAmountsMatch(manual.total_amount_clp, contractAmt)) return false;

  // Manual entry vs statement posting skews by a day or two (weekend/posting lag), so with
  // merchant, contract amount and cuota count already matched above, tolerate ±2 days.
  const lineIso = purchaseIsoFromLineFields(line.transaction_date, line.posting_date);
  if (lineIso && isoDaysApart(lineIso, manual.purchase_date) <= 2) return true;

  const cur = line.nro_cuota_current;
  const isContractResumen = cur == null || cur === 0;
  return isContractResumen && purchaseAmountsMatch(manual.total_amount_clp, contractAmt);
}

function isoDaysApart(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / 86_400_000;
}

function resolveCategoryIdForManualPurchase(accountId: number, manualId: number, manualKey: string | null): number | null {
  if (manualKey) {
    const r = selUniqueCat.get(accountId, manualKey) as { category_id: number } | undefined;
    if (r?.category_id != null) return r.category_id;
    // Fall back to the pre-amount (legacy) installment-h key so categories stored before the
    // key gained the total-amount segment still resolve.
    const legacy = legacyInstallmentHPurchaseKey(manualKey);
    if (legacy) {
      const rLegacy = selUniqueCat.get(accountId, legacy) as { category_id: number } | undefined;
      if (rLegacy?.category_id != null) return rLegacy.category_id;
    }
  }
  const instKey = `installment:${manualId}`;
  const r2 = selUniqueCat.get(accountId, instKey) as { category_id: number } | undefined;
  return r2?.category_id ?? null;
}

function applyCategoryToMatchedLines(accountId: number, matchedLineId: number, categoryId: number): void {
  const siblingIds = listInstallmentPurchaseSiblingStatementLineIds(matchedLineId);
  const seen = new Set<number>();
  for (const lineId of siblingIds) {
    if (seen.has(lineId)) continue;
    seen.add(lineId);
    insLineCat.run(lineId, categoryId);
    const ctx = loadCcStatementLineExpenseCtx(lineId);
    if (!ctx || ctx.account_id !== accountId) continue;
    const stable = stableCcExpensePurchaseKeyFromCtx(ctx);
    upsertUniqueCat.run(accountId, stable, categoryId);
  }
}

function deleteManualPurchaseExpenseKeys(accountId: number, manualId: number, manualKey: string | null): void {
  if (manualKey) {
    delUniqueByKey.run(accountId, manualKey);
    const legacy = legacyInstallmentHPurchaseKey(manualKey);
    if (legacy) delUniqueByKey.run(accountId, legacy);
  }
  delUniqueByKey.run(accountId, `installment:${manualId}`);
}

export type CcManualInstallmentReconcileMatch = {
  manual_id: number;
  manual_merchant: string | null;
  manual_purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  statement_id: number;
  statement_source_pdf: string;
  line_id: number;
  line_merchant: string | null;
  /** `deleted` = a separate pdf plan represents the contract; `converted` = this row became it. */
  action: "deleted" | "converted";
};

export type CcManualInstallmentReconcileResult = {
  statements_considered: number;
  matched: number;
  deleted: number;
  /** Manual rows flipped to source='pdf' because no separate pdf plan existed for the contract. */
  converted: number;
  categories_transferred: number;
  purchase_key_refs_rewritten: number;
  matches: CcManualInstallmentReconcileMatch[];
};

/**
 * Resolves statement DB ids touched by this import batch (PDF sources only).
 */
export function collectStatementIdsFromImportRecords(
  accountId: number,
  records: readonly CcStatementCsvRecord[]
): number[] {
  const keys = new Set<string>();
  for (const r of records) {
    const src = String(r.source_pdf ?? "").trim();
    if (!src || src.startsWith("import:web-paste")) continue;
    keys.add(statementKeyFromRow(r));
  }
  const ids: number[] = [];
  for (const k of keys) {
    const parts = k.split("\t");
    const card_group = parts[0] ?? "A";
    const source_pdf = parts[1] ?? "";
    const statement_date = parts[2] ?? "";
    const row = findStmtId.get(accountId, card_group, source_pdf, statement_date) as
      | { id: number }
      | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * After PDF statements and installment ledger are merged: delete manual purchases that
 * duplicate a statement installment line (date + amount + merchant, purchase date inside
 * statement facturación period), and carry category assignments to the PDF-backed lines.
 */
export function reconcileManualInstallmentPurchasesForStatements(
  accountId: number,
  statementIds: readonly number[],
  opts?: { dryRun?: boolean }
): CcManualInstallmentReconcileResult {
  const dryRun = opts?.dryRun === true;
  if (statementIds.length === 0) {
    return {
      statements_considered: 0,
      matched: 0,
      deleted: 0,
      converted: 0,
      categories_transferred: 0,
      purchase_key_refs_rewritten: 0,
      matches: [],
    };
  }

  let matched = 0;
  let deleted = 0;
  let converted = 0;
  let categoriesTransferred = 0;
  let purchaseKeyRefsRewritten = 0;
  const matches: CcManualInstallmentReconcileMatch[] = [];
  // Plans converted from web-pasted lines inherit the web-paste statement's issuer-derived
  // card_group (e.g. 'santander'), while PDF statements keep the legacy parser groups
  // ('A'/'B'/'INTL') — those rows must still reconcile against any of the account's PDF
  // statements, or every web-paste-converted plan survives its PDF close as a duplicate.
  const webPasteGroup = creditCardMasterMetaForAccount(accountId)?.cardGroup ?? null;

  const run = db.transaction(() => {
    const manuals = listManualPurchases.all(accountId) as {
      id: number;
      card_group: string;
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant: string | null;
    }[];

    const consumedLineIds = new Set<number>();
    const consumedManualIds = new Set<number>();

    for (const stmtId of statementIds) {
      const st = loadStatementMeta.get(stmtId) as
        | {
            id: number;
            account_id: number;
            card_group: string;
            source_pdf: string;
            period_from: string | null;
            period_to: string | null;
          }
        | undefined;
      if (!st || st.account_id !== accountId) continue;
      if (String(st.source_pdf ?? "").trim().startsWith("import:web-paste")) continue;

      const lines = listInstallmentLinesForStatement.all(stmtId) as {
        id: number;
        installment_flag: number;
        merchant: string | null;
        transaction_date: string | null;
        posting_date: string | null;
        nro_cuota_total: number | null;
        nro_cuota_current: number | null;
        amount_clp: number | null;
        valor_cuota_mensual_clp: number | null;
      }[];

      for (const manual of manuals) {
        if (consumedManualIds.has(manual.id)) continue;
        const manualGroup = String(manual.card_group ?? "A").trim();
        const groupCompatible =
          manualGroup === String(st.card_group ?? "A").trim() ||
          (webPasteGroup != null && manualGroup === webPasteGroup);
        if (!groupCompatible) continue;
        if (!isIsoInInclusivePeriod(manual.purchase_date, st.period_from, st.period_to)) continue;

        const manualKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
          accountId,
          purchaseDateIso: manual.purchase_date,
          cuotasTotales: manual.cuotas_totales,
          totalAmountClp: manual.total_amount_clp,
          merchant: manual.merchant,
        });

        let hitLine: (typeof lines)[number] | null = null;
        for (const line of lines) {
          if (consumedLineIds.has(line.id)) continue;
          if (isInstallmentContractSummaryMerchant(String(line.merchant ?? ""))) continue;
          if (!manualMatchesInstallmentLine(manual, line)) continue;
          hitLine = line;
          break;
        }
        if (hitLine == null) continue;

        consumedLineIds.add(hitLine.id);
        consumedManualIds.add(manual.id);
        matched += 1;
        const hasSeparatePdfPlan = separatePdfPlanExistsForLine(accountId, manual.id, hitLine);
        matches.push({
          manual_id: manual.id,
          manual_merchant: manual.merchant,
          manual_purchase_date: manual.purchase_date,
          total_amount_clp: manual.total_amount_clp,
          cuotas_totales: manual.cuotas_totales,
          statement_id: st.id,
          statement_source_pdf: st.source_pdf,
          line_id: hitLine.id,
          line_merchant: hitLine.merchant,
          action: hasSeparatePdfPlan ? "deleted" : "converted",
        });
        if (dryRun) continue;

        if (!hasSeparatePdfPlan) {
          // The ledger merge fingerprint-matched the statement contract into this manual row
          // (identical merchant/date/amount), so it is the contract's only ledger row — its
          // payments, categories, notes and financing-link keys are live. Adopt it as the
          // statement-backed plan instead of deleting real data.
          convertManualPurchaseToPdf.run(st.source_pdf, manual.id, accountId);
          converted += 1;
          continue;
        }

        const categoryId = resolveCategoryIdForManualPurchase(accountId, manual.id, manualKey);
        if (categoryId != null) {
          applyCategoryToMatchedLines(accountId, hitLine.id, categoryId);
          categoriesTransferred += 1;
        }

        deleteManualPurchaseExpenseKeys(accountId, manual.id, manualKey);
        delManualPurchase.run(manual.id, accountId);
        deleted += 1;

        // Facturado-financing links, notes and big-group assignments reference the plan by
        // purchase_key (which embeds the manual's merchant text) — repoint them at the key the
        // surviving PDF side's gastos rows will carry, or e.g. a financing link silently stops
        // projecting its financed facturación the moment the twin collapses.
        const pdfKey = pdfPurchaseKeyForMatchedLine(accountId, hitLine);
        if (pdfKey) {
          const manualKeys = [manualKey, manualKey ? legacyInstallmentHPurchaseKey(manualKey) : null]
            .filter((k): k is string => k != null);
          purchaseKeyRefsRewritten += migrateManualPurchaseKeyRefs(accountId, manualKeys, pdfKey);
        }
      }
    }
  });

  run();

  if (deleted > 0 || converted > 0) {
    // Deleting a twin removes dated evidence (its purchase-date ramp in the daily owed
    // walk), so today-stamps written while it existed must self-purge from its purchase
    // date onward — same contract as manual installment delete. Conversions keep the row
    // (no evidence removed), so they don't widen the purge window.
    const earliestDeletedYmd = matches.reduce<string | null>(
      (min, m) =>
        m.action === "deleted" && (min == null || m.manual_purchase_date < min)
          ? m.manual_purchase_date
          : min,
      null
    );
    upsertCreditCardValuationsFromLedger(accountId, {
      affectedEvidenceFromYmd: earliestDeletedYmd ?? undefined,
    });
    recomputeCcBillingMonthBalances(accountId);
  }

  return {
    statements_considered: statementIds.length,
    matched,
    deleted,
    converted,
    categories_transferred: categoriesTransferred,
    purchase_key_refs_rewritten: purchaseKeyRefsRewritten,
    matches,
  };
}

export function reconcileManualInstallmentPurchasesAfterStatementImport(
  accountId: number,
  records: readonly CcStatementCsvRecord[]
): CcManualInstallmentReconcileResult {
  const ids = collectStatementIdsFromImportRecords(accountId, records);
  return reconcileManualInstallmentPurchasesForStatements(accountId, ids);
}
