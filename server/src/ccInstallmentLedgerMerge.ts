import { db } from "./db.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { removeOneShotLinesSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { backfillMissingInstallmentPaymentsForAccount } from "./ccInstallmentPaymentBackfill.js";
import { resolveInstallmentPayByIso, parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import {
  importCcStatementsMerge,
  statementKeyFromRow,
  type CcStatementCsvRecord,
  type CcStatementsMergeOpts,
} from "./ccStatementsImport.js";
import { reconcileManualInstallmentPurchasesAfterStatementImport } from "./ccManualInstallmentStatementReconcile.js";
import { repairMisplacedOpenWebPasteBuckets } from "./ccOpenWebPasteRepair.js";
import {
  reconcileOpenWebPasteAfterPdfImports,
  type CcOpenWebPastePdfReconcileResult,
} from "./ccOpenWebPastePdfReconcile.js";
import { assertCcImportReconcilesOrThrow } from "./ccStatementImportReconcile.js";
import { installmentPurchaseLedgerDedupeKey } from "./ccInstallmentLedgerDb.js";
import { statementPeriodMonthFromParsedRow } from "./ccInstallmentStatementMonth.js";
import { loadCreditCardInstallmentPurchases } from "./creditCardInstallments.js";

function parseInt10(s: string): number | null {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function installmentContractAmountClp(row: CcStatementCsvRecord): number {
  const a = parseInt10(String(row.amount_clp ?? "")) ?? 0;
  const b = parseInt10(String(row.monto_origen_operacion_clp ?? "")) ?? 0;
  const c = parseInt10(String(row.monto_total_a_pagar_clp ?? "")) ?? 0;
  return Math.max(a, b, c);
}

type Agg = {
  card_group: string;
  canonical_row_id: string;
  rows: CcStatementCsvRecord[];
};

function txDateIso(row: CcStatementCsvRecord): string | null {
  const raw = String(row.transaction_date ?? row.posting_date ?? "").trim();
  return parseDdMmYyToIso(raw);
}

function makeLoanKey(row: CcStatementCsvRecord): string | null {
  const cg = String(row.card_group ?? "A").trim() || "A";
  const iso = txDateIso(row);
  const amt = installmentContractAmountClp(row);
  const nt = parseInt10(String(row.nro_cuota_total ?? ""));
  if (!iso || amt <= 0 || nt == null || nt <= 0) return null;
  const merch =
    merchantStemForInstallmentDedupe(row.merchant) ||
    merchantStemForInstallmentDedupe(row.description_merged);
  if (!merch) return null;
  return `${cg}\t${iso}\t${amt}\t${nt}\t${merch.toUpperCase()}`;
}

function pickCanonicalForLoan(rows: CcStatementCsvRecord[]): string {
  const ids = [
    ...new Set(
      rows
        .map((r) => String(r.canonical_row_id ?? "").trim())
        .filter(Boolean)
    ),
  ].sort();
  return ids[0] ?? "unknown";
}

function stmtSortKey(statementDate: string): number {
  const iso = parseDdMmYyToIso(statementDate);
  if (!iso) return 0;
  return Number(iso.replace(/-/g, ""));
}

export type CcInstallmentLedgerMergeResult = {
  purchaseUpserts: number;
  paymentUpserts: number;
  gapFilled: number;
  valuationMonthsSynced: number;
  billingSnapshots: number;
};

export type CcInstallmentLedgerMergeOpts = {
  /** Wipe ledger for account before merge (`import:cc-parsed --wipe`). */
  replaceLedger?: boolean;
};

export function mergeInstallmentLedgerFromParsedRows(
  accountId: number,
  accountRecords: CcStatementCsvRecord[],
  opts?: CcInstallmentLedgerMergeOpts
): CcInstallmentLedgerMergeResult {
  const replaceLedger = opts?.replaceLedger === true;
  const baselineIds = new Set(loadCreditCardInstallmentPurchases().map((r) => r.purchase_id));

  const byLoan = new Map<string, Agg>();
  for (const row of accountRecords) {
    const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
    if (!inst) continue;
    if (isInstallmentContractSummaryMerchant(String(row.merchant ?? ""))) continue;
    if (installmentContractAmountClp(row) <= 0) continue;
    const loanKey = makeLoanKey(row);
    if (!loanKey) continue;
    const cg = String(row.card_group ?? "A").trim() || "A";
    const g = byLoan.get(loanKey) ?? { card_group: cg, canonical_row_id: "", rows: [] };
    g.rows.push(row);
    g.canonical_row_id = pickCanonicalForLoan(g.rows);
    byLoan.set(loanKey, g);
  }

  const insP = db.prepare(
    `INSERT INTO cc_installment_purchases (
       account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
       purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
     ) VALUES (
       @account_id, @card_group, @canonical_row_id, @dedupe_key, @parser_row_id_sample, @source_pdf_sample,
       @purchase_date, @total_amount_clp, @cuotas_totales, @merchant, @description_merged, @matched_baseline_purchase_id, 'pdf'
     )
     ON CONFLICT(account_id, card_group, canonical_row_id) DO UPDATE SET
       dedupe_key = COALESCE(excluded.dedupe_key, dedupe_key),
       parser_row_id_sample = COALESCE(excluded.parser_row_id_sample, parser_row_id_sample),
       source_pdf_sample = COALESCE(excluded.source_pdf_sample, source_pdf_sample),
       purchase_date = excluded.purchase_date,
       total_amount_clp = CASE WHEN cc_installment_purchases.source = 'manual'
         THEN COALESCE(NULLIF(cc_installment_purchases.total_amount_clp, 0), excluded.total_amount_clp)
         ELSE excluded.total_amount_clp END,
       cuotas_totales = CASE WHEN cc_installment_purchases.source = 'manual'
         THEN COALESCE(NULLIF(cc_installment_purchases.cuotas_totales, 0), excluded.cuotas_totales)
         ELSE excluded.cuotas_totales END,
       merchant = COALESCE(NULLIF(cc_installment_purchases.merchant, ''), excluded.merchant),
       description_merged = COALESCE(NULLIF(cc_installment_purchases.description_merged, ''), excluded.description_merged),
       matched_baseline_purchase_id = excluded.matched_baseline_purchase_id`
  );

  const insPay = db.prepare(
    `INSERT INTO cc_installment_payments (
       purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
     ) VALUES (
       @purchase_id, @pay_by_date, @statement_date, @statement_period_month, @source_pdf, @amount_clp, @cuota_current, @cuota_total, @parser_row_id
     )
     ON CONFLICT(purchase_id, pay_by_date) DO UPDATE SET
       statement_date = excluded.statement_date,
       statement_period_month = excluded.statement_period_month,
       source_pdf = excluded.source_pdf,
       amount_clp = excluded.amount_clp,
       cuota_current = excluded.cuota_current,
       cuota_total = excluded.cuota_total,
       parser_row_id = excluded.parser_row_id`
  );

  const selId = db.prepare(
    `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND card_group = ? AND canonical_row_id = ?`
  );

  let purchaseUpserts = 0;
  let paymentUpserts = 0;

  const run = db.transaction(() => {
    if (replaceLedger) {
      db.prepare(
        `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
      ).run(accountId);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ? AND source != 'manual'`).run(
        accountId
      );
    }

    const purchaseIdByFingerprint = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant
         FROM cc_installment_purchases WHERE account_id = ?`
      )
      .all(accountId) as {
      id: number;
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant: string | null;
    }[]) {
      const fp = installmentPurchaseLedgerDedupeKey(row);
      const prev = purchaseIdByFingerprint.get(fp);
      if (prev == null || row.id < prev) purchaseIdByFingerprint.set(fp, row.id);
    }

    for (const [loanKey, agg] of byLoan.entries()) {
      const sorted = [...agg.rows].sort(
        (a, b) => stmtSortKey(a.statement_date ?? "") - stmtSortKey(b.statement_date ?? "")
      );
      const first = sorted[0]!;
      let purchaseDate: string | null = null;
      for (const r of sorted) {
        const iso = txDateIso(r);
        if (iso && (!purchaseDate || iso < purchaseDate)) purchaseDate = iso;
      }
      if (!purchaseDate) purchaseDate = parseDdMmYyToIso(first.statement_date ?? "") ?? "2000-01-01";

      let maxTotal = 0;
      let maxCuotas = 0;
      for (const r of sorted) {
        if (isInstallmentContractSummaryMerchant(String(r.merchant ?? ""))) continue;
        maxTotal = Math.max(maxTotal, installmentContractAmountClp(r));
        const nt = parseInt10(String(r.nro_cuota_total ?? ""));
        if (nt != null && nt > 0) maxCuotas = Math.max(maxCuotas, nt);
      }
      if (maxCuotas <= 0) continue;

      const matched = String(first.matched_excel_row ?? "").trim();
      const matched_baseline = baselineIds.has(matched) ? matched : null;

      const merchant = String(first.merchant ?? "").trim() || null;
      const fingerprint = installmentPurchaseLedgerDedupeKey({
        purchase_date: purchaseDate,
        total_amount_clp: maxTotal,
        cuotas_totales: maxCuotas,
        merchant,
      });
      let pid = purchaseIdByFingerprint.get(fingerprint);
      if (pid == null) {
        insP.run({
          account_id: accountId,
          card_group: agg.card_group,
          canonical_row_id: agg.canonical_row_id,
          dedupe_key: String(first.dedupe_key ?? "").trim() || loanKey,
          parser_row_id_sample: String(first.row_id ?? "").trim() || null,
          source_pdf_sample: String(first.source_pdf ?? "").trim() || null,
          purchase_date: purchaseDate,
          total_amount_clp: maxTotal,
          cuotas_totales: maxCuotas,
          merchant,
          description_merged: String(first.description_merged ?? "").trim() || null,
          matched_baseline_purchase_id: matched_baseline,
        });
        purchaseUpserts++;
        pid = (selId.get(accountId, agg.card_group, agg.canonical_row_id) as { id: number }).id;
        purchaseIdByFingerprint.set(fingerprint, pid);
      } else {
        db.prepare(
          `UPDATE cc_installment_purchases SET
             purchase_date = @purchase_date,
             total_amount_clp = @total_amount_clp,
             cuotas_totales = @cuotas_totales,
             merchant = COALESCE(NULLIF(merchant, ''), @merchant),
             description_merged = COALESCE(NULLIF(description_merged, ''), @description_merged),
             dedupe_key = COALESCE(@dedupe_key, dedupe_key),
             parser_row_id_sample = COALESCE(@parser_row_id_sample, parser_row_id_sample),
             source_pdf_sample = COALESCE(@source_pdf_sample, source_pdf_sample),
             matched_baseline_purchase_id = COALESCE(@matched_baseline_purchase_id, matched_baseline_purchase_id)
           WHERE id = @id`
        ).run({
          id: pid,
          purchase_date: purchaseDate,
          total_amount_clp: maxTotal,
          cuotas_totales: maxCuotas,
          merchant,
          description_merged: String(first.description_merged ?? "").trim() || null,
          dedupe_key: String(first.dedupe_key ?? "").trim() || loanKey,
          parser_row_id_sample: String(first.row_id ?? "").trim() || null,
          source_pdf_sample: String(first.source_pdf ?? "").trim() || null,
          matched_baseline_purchase_id: matched_baseline,
        });
        purchaseUpserts++;
      }

      const payGroups = new Map<string, CcStatementCsvRecord[]>();
      for (const r of sorted) {
        const pk = `${r.source_pdf}\t${r.statement_date}`;
        const list = payGroups.get(pk) ?? [];
        list.push(r);
        payGroups.set(pk, list);
      }

      for (const list of payGroups.values()) {
        const chosen = [...list].sort((a, b) => {
          const da = String(a.is_duplicate_across_statements ?? "").toLowerCase() === "true";
          const dbi = String(b.is_duplicate_across_statements ?? "").toLowerCase() === "true";
          if (da !== dbi) return da ? 1 : -1;
          return String(a.row_id ?? "").localeCompare(String(b.row_id ?? ""));
        })[0]!;

        const payBy = resolveInstallmentPayByIso({
          pay_by: chosen.pay_by,
          statement_date: chosen.statement_date,
          period_to: chosen.period_to,
          transaction_date: chosen.transaction_date,
        });
        if (!payBy) continue;
        const cuotaAmt = parseInt10(String(chosen.valor_cuota_mensual_clp ?? ""));
        if (cuotaAmt == null || cuotaAmt <= 0) continue;
        const ccRaw = String(chosen.nro_cuota_current ?? "").trim();
        const cuota_current = ccRaw ? parseInt10(ccRaw) : null;
        const ct = parseInt10(String(chosen.nro_cuota_total ?? ""));
        const cuota_total = ct != null && ct > 0 ? ct : maxCuotas;

        insPay.run({
          purchase_id: pid,
          pay_by_date: payBy,
          statement_date: String(chosen.statement_date ?? "").trim() || null,
          statement_period_month: statementPeriodMonthFromParsedRow(chosen),
          source_pdf: String(chosen.source_pdf ?? "").trim() || null,
          amount_clp: cuotaAmt,
          cuota_current,
          cuota_total,
          parser_row_id: String(chosen.row_id ?? "").trim() || null,
        });
        paymentUpserts++;
      }
    }
  });

  run();

  const gapFilled = backfillMissingInstallmentPaymentsForAccount(accountId).inserted;
  removeOneShotLinesSupersededByInstallmentPurchases(accountId, { recompute: false });
  const valuationMonthsSynced = upsertCreditCardValuationsFromLedger(accountId);
  const billingSnapshots = recomputeCcBillingMonthBalances(accountId);

  return {
    purchaseUpserts,
    paymentUpserts,
    gapFilled,
    valuationMonthsSynced,
    billingSnapshots,
  };
};

export type CcAccountImportMergeResult = {
  statements: ReturnType<typeof importCcStatementsMerge>;
  ledger: CcInstallmentLedgerMergeResult;
  overlap_removed: number;
  manual_installment_reconcile: ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport>;
  web_paste_repair: ReturnType<typeof repairMisplacedOpenWebPasteBuckets>;
  web_paste_pdf_reconcile: CcOpenWebPastePdfReconcileResult[];
};

/** Merge statements + installment ledger + billing (HTTP imports). */
export function mergeCcAccountFromParsedRows(
  accountId: number,
  records: CcStatementCsvRecord[],
  opts?: {
    statements?: CcStatementsMergeOpts;
    replaceLedger?: boolean;
    replaceStatementKeys?: Set<string>;
  }
): CcAccountImportMergeResult {
  const replaceKeys = opts?.replaceStatementKeys;
  // Validate before writing anything — throws if reconcile pre-checks fail.
  assertCcImportReconcilesOrThrow(accountId, records, {
    replaceStatementKeys: replaceKeys,
  });

  // All writes in one transaction so a mid-merge error (e.g. missing import) leaves
  // no partial state and a retry is a true no-op.
  const result = db.transaction((): CcAccountImportMergeResult => {
    const statements = importCcStatementsMerge(accountId, records, {
      replaceAll: false,
      replaceStatementKeys: replaceKeys,
      skipGlobalDedupeKeys: true,
      ...opts?.statements,
    });
    const ledger = mergeInstallmentLedgerFromParsedRows(accountId, records, {
      replaceLedger: opts?.replaceLedger ?? false,
    });
    const manual_installment_reconcile = reconcileManualInstallmentPurchasesAfterStatementImport(
      accountId,
      records
    );
    const overlap = removeOneShotLinesSupersededByInstallmentPurchases(accountId);
    const web_paste_repair = repairMisplacedOpenWebPasteBuckets(accountId, {
      skipRecompute: true,
    });
    const web_paste_pdf_reconcile = reconcileOpenWebPasteAfterPdfImports(accountId, records, {
      skipRecompute: true,
    });
    return {
      statements,
      ledger,
      overlap_removed: overlap.removed_count,
      manual_installment_reconcile,
      web_paste_repair,
      web_paste_pdf_reconcile,
    };
  })();

  // Recompute billing balances once after the transaction commits so it reads
  // the fully-consistent post-merge state.
  recomputeCcBillingMonthBalances(accountId);

  return result;
}

export function replaceStatementKeysFromRecords(records: CcStatementCsvRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const row of records) {
    keys.add(statementKeyFromRow(row));
  }
  return keys;
}
