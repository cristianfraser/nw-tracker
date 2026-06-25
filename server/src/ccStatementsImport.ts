import { db } from "./db.js";
import { oneShotLineFuzzyMatchExists, shouldSkipOneShotStatementImport } from "./ccCrossImportDedupe.js";
import {
  propagateCcExpenseMerchantRulesAcrossGroup,
  propagateCcExpenseMerchantRulesFromLegacy,
  restoreCcExpenseCategories,
  snapshotCcExpenseCategories,
} from "./ccExpenseCategoryPersist.js";
import {
  applyAdditionalCardNoCuentaForLine,
} from "./ccAdditionalCardExpenseMatch.js";
import {
  canonicalCcLineDedupeKeys,
  ccLineDedupeKeyExistsOnAccount,
  patchCcLineOriginCardOnDedupeHit,
} from "./ccExpenseLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

function parseInt10(s: string): number | null {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseUsdAmount(s: string): number | null {
  let t = String(s ?? "").trim().replace(/US\$/gi, "").replace(/\$/g, "").trim();
  if (!t) return null;
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1).trim();
  if (/,\d{1,2}$/.test(t)) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function parseOrigAmount(s: string, currency?: string): number | null {
  if (currency === "usd" || String(s).includes("US$")) {
    return parseUsdAmount(s);
  }
  const t = String(s ?? "").trim();
  if (!t) return null;
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1).trim() : t;
  const v = body.replace(/\./g, "").replace(",", ".");
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export type CcStatementCsvRecord = Record<string, string>;

export function statementKeyFromRow(row: CcStatementCsvRecord): string {
  return `${row.card_group ?? "A"}\t${row.source_pdf ?? ""}\t${row.statement_date ?? ""}`;
}

function assertCcStatementCsvHeader(row: CcStatementCsvRecord): void {
  const sourcePdf = String(row.source_pdf ?? "").trim();
  if (!sourcePdf || sourcePdf.startsWith("import:web-paste")) return;
  const missing: string[] = [];
  if (!String(row.statement_date ?? "").trim()) missing.push("statement_date");
  if (!String(row.period_from ?? "").trim()) missing.push("period_from");
  if (!String(row.period_to ?? "").trim()) missing.push("period_to");
  if (missing.length === 0) return;
  throw new Error(
    `CC statement import missing ${missing.join(", ")} for ${sourcePdf}; ` +
      `re-run parse:cc-pdfs and import`
  );
}

function layoutFromRow(row: CcStatementCsvRecord): string {
  const layout = String(row.parser_layout ?? "").trim();
  if (layout === "international_usd") return "international_usd";
  if (layout.startsWith("wide")) return "wide";
  return "compact";
}

export function currencyFromRow(row: CcStatementCsvRecord): string {
  if (String(row.currency ?? "").toLowerCase() === "usd") return "usd";
  if (layoutFromRow(row) === "international_usd") return "usd";
  return "clp";
}

export type CcStatementsMergeResult = {
  statementCount: number;
  lineCount: number;
  linesInserted: number;
  linesSkippedDuplicate: number;
  /** One-shot line skipped — same date+amount+fuzzy merchant already exists (different truncation). */
  linesSkippedFuzzyDuplicate: number;
  /** One-shot line skipped — same purchase already in installment ledger. */
  linesSkippedInstallmentOverlap: number;
  /** Existing lines whose origin_card_last4 was updated on dedupe skip. */
  linesOriginCardPatched: number;
  /** Adicional-card lines auto-tagged Único + no_cuenta during import. */
  additionalCardCategoriesApplied: number;
  categoriesRestored: number;
};

export type CcStatementsMergeOpts = {
  /** Wipe all statements for the account before import (`import:cc-parsed --wipe`). */
  replaceAll?: boolean;
  /** Replace only these statement keys (`card_group\\tsource_pdf\\tstatement_date`). */
  replaceStatementKeys?: Set<string>;
  /** Skip line when dedupe_key already exists on any statement for this account. */
  skipGlobalDedupeKeys?: boolean;
};

const findStmtId = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

/** Same billing close re-imported from a different PDF filename (CLP vs USD stay separate). */
const findStmtByClose = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND statement_date = ?
     AND COALESCE(card_last4, '') = COALESCE(?, '')
     AND currency = ?
   ORDER BY id ASC
   LIMIT 1`
);

function originCardLast4FromCsvRow(
  row: CcStatementCsvRecord,
  primaryCardLast4: string | null
): string | null {
  const v = String(row.origin_card_last4 ?? "").trim();
  if (v.length > 0) return v;
  return primaryCardLast4;
}

function maybeApplyAdditionalCardNoCuenta(
  accountId: number,
  statementLineId: number,
  originCardLast4: string | null,
  primaryCardLast4: string | null
): boolean {
  const result = applyAdditionalCardNoCuentaForLine({
    accountId,
    statementLineId,
    originCardLast4,
    primaryCardLast4,
  });
  return result.applied;
}

export function importCcStatementsMerge(
  accountId: number,
  records: CcStatementCsvRecord[],
  opts?: CcStatementsMergeOpts
): CcStatementsMergeResult {
  propagateCcExpenseMerchantRulesFromLegacy(accountId);
  propagateCcExpenseMerchantRulesAcrossGroup("santander");
  const categorySnap = snapshotCcExpenseCategories(accountId);

  const replaceAll = opts?.replaceAll === true;
  const replaceKeys = opts?.replaceStatementKeys;
  const skipGlobalDedupe = opts?.skipGlobalDedupeKeys !== false;

  if (replaceAll) {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
        SELECT id FROM cc_statements WHERE account_id = ?
      )`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  }

  const byStmt = new Map<string, CcStatementCsvRecord[]>();
  for (const row of records) {
    const k = statementKeyFromRow(row);
    const list = byStmt.get(k) ?? [];
    list.push(row);
    byStmt.set(k, list);
  }

  const insStmt = db.prepare(`
    INSERT INTO cc_statements (
      account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
      card_last4, card_product, layout, currency,
      saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
    ) VALUES (
      @account_id, @card_group, @source_pdf, @statement_date, @period_from, @period_to, @pay_by,
      @card_last4, @card_product, @layout, @currency,
      @saldo_anterior, @abono, @compras_cargos, @deuda_total, @monto_facturado
    )
  `);

  const updStmt = db.prepare(`
    UPDATE cc_statements SET
      statement_date = @statement_date,
      period_from = @period_from, period_to = @period_to, pay_by = @pay_by,
      card_last4 = @card_last4, card_product = @card_product, layout = @layout, currency = @currency,
      saldo_anterior = @saldo_anterior, abono = @abono, compras_cargos = @compras_cargos,
      deuda_total = @deuda_total, monto_facturado = @monto_facturado
    WHERE id = @id
  `);

  const delLinesForStmt = db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`);

  const insLine = db.prepare(`
    INSERT INTO cc_statement_lines (
      statement_id, transaction_date, posting_date, place, merchant, description_merged,
      country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
      nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
      interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line, origin_card_last4
    ) VALUES (
      @statement_id, @transaction_date, @posting_date, @place, @merchant, @description_merged,
      @country, @amount_orig, @orig_currency, @amount_clp, @amount_usd, @installment_flag,
      @nro_cuota_current, @nro_cuota_total, @valor_cuota_mensual_clp, @valor_cuota_mensual_usd,
      @interest_rate_text, @tipo_cuota, @dedupe_key, @parser_row_id, @raw_line, @origin_card_last4
    )
  `);

  let statementCount = 0;
  let lineCount = 0;
  let linesInserted = 0;
  let linesSkippedDuplicate = 0;
  let linesSkippedFuzzyDuplicate = 0;
  let linesSkippedInstallmentOverlap = 0;
  let linesOriginCardPatched = 0;
  let additionalCardCategoriesApplied = 0;

  for (const [key, rows] of byStmt) {
    const first = rows[0]!;
    assertCcStatementCsvHeader(first);
    const currency = currencyFromRow(first);
    const cardGroup = String(first.card_group ?? "A").trim() || "A";
    const sourcePdf = String(first.source_pdf ?? "").trim();
    const statementDate = String(first.statement_date ?? "").trim();

    const header = {
      saldo_anterior:
        parseUsdAmount(String(first.statement_saldo_anterior ?? "")) ??
        parseInt10(String(first.statement_saldo_anterior ?? "")),
      abono:
        parseUsdAmount(String(first.statement_abono ?? "")) ??
        parseInt10(String(first.statement_abono ?? "")),
      compras_cargos:
        parseUsdAmount(String(first.statement_compras_cargos ?? "")) ??
        parseInt10(String(first.statement_compras_cargos ?? "")),
      deuda_total:
        parseUsdAmount(String(first.statement_deuda_total ?? "")) ??
        parseInt10(String(first.statement_deuda_total ?? "")),
      monto_facturado: (() => {
        const v =
          parseUsdAmount(String(first.statement_monto_facturado ?? "")) ??
          parseInt10(String(first.statement_monto_facturado ?? ""));
        return v != null && v > 0 ? v : null;
      })(),
    };

    const stmtParams = {
      account_id: accountId,
      card_group: cardGroup,
      source_pdf: sourcePdf,
      statement_date: statementDate,
      period_from: String(first.period_from ?? "").trim() || null,
      period_to: String(first.period_to ?? "").trim() || null,
      pay_by: String(first.pay_by ?? "").trim() || null,
      card_last4: String(first.card_last4 ?? "").trim() || null,
      card_product: String(first.card_product ?? "").trim() || null,
      layout: layoutFromRow(first),
      currency,
      ...header,
    };

    let statementId: number;
    const cardLast4 = String(first.card_last4 ?? "").trim() || null;
    let existing = findStmtId.get(accountId, cardGroup, sourcePdf, statementDate) as
      | { id: number }
      | undefined;
    if (!existing) {
      existing = findStmtByClose.get(
        accountId,
        cardGroup,
        statementDate,
        cardLast4,
        currency
      ) as { id: number } | undefined;
    }

    if (existing) {
      statementId = existing.id;
      updStmt.run({ ...stmtParams, id: statementId });
      if (replaceKeys?.has(key) || replaceAll) {
        delLinesForStmt.run(statementId);
      }
    } else {
      const r = insStmt.run(stmtParams);
      statementId = Number(r.lastInsertRowid);
    }
    statementCount += 1;

    const seenDedupeInBatch = new Set<string>();

    for (const row of rows) {
      const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
      const amountClp = parseInt10(String(row.amount_clp ?? ""));
      const amountUsd = parseUsdAmount(String(row.amount_usd ?? ""));
      const dedupeKeys = canonicalCcLineDedupeKeys(cardGroup, row);
      const dedupeKey = dedupeKeys[0] ?? null;

      if (dedupeKeys.length > 0) {
        const batchHit = dedupeKeys.some((k) => seenDedupeInBatch.has(k));
        if (batchHit) {
          linesSkippedDuplicate += 1;
          continue;
        }
        for (const k of dedupeKeys) seenDedupeInBatch.add(k);
        if (skipGlobalDedupe && ccLineDedupeKeyExistsOnAccount(accountId, dedupeKeys)) {
          const originCardLast4 = originCardLast4FromCsvRow(row, cardLast4);
          const patch = patchCcLineOriginCardOnDedupeHit(accountId, dedupeKeys, originCardLast4);
          if (patch.patched) linesOriginCardPatched += 1;
          if (patch.lineId != null) {
            if (
              maybeApplyAdditionalCardNoCuenta(
                accountId,
                patch.lineId,
                originCardLast4,
                cardLast4
              )
            ) {
              additionalCardCategoriesApplied += 1;
            }
          }
          linesSkippedDuplicate += 1;
          continue;
        }
      }

      if (!inst && amountClp != null && amountClp > 0) {
        const purchaseDateIso =
          parseDdMmYyToIso(String(row.transaction_date ?? "").trim()) ??
          parseDdMmYyToIso(String(row.posting_date ?? "").trim());
        const merchant = String(row.merchant ?? "").trim() || null;
        if (shouldSkipOneShotStatementImport(accountId, merchant, purchaseDateIso, amountClp)) {
          linesSkippedInstallmentOverlap += 1;
          continue;
        }
        if (oneShotLineFuzzyMatchExists(accountId, merchant, purchaseDateIso, amountClp)) {
          linesSkippedFuzzyDuplicate += 1;
          continue;
        }
      }

      const originCardLast4 = originCardLast4FromCsvRow(row, cardLast4);

      const ins = insLine.run({
        statement_id: statementId,
        transaction_date: String(row.transaction_date ?? "").trim() || null,
        posting_date: String(row.posting_date ?? "").trim() || null,
        place: String(row.place ?? "").trim() || null,
        merchant: String(row.merchant ?? "").trim() || null,
        description_merged: String(row.description_merged ?? "").trim() || null,
        country: String(row.country ?? "").trim() || null,
        amount_orig: parseOrigAmount(String(row.amount_orig ?? ""), currency),
        orig_currency: String(row.orig_currency ?? "").trim() || null,
        amount_clp: amountClp,
        amount_usd: amountUsd,
        installment_flag: inst ? 1 : 0,
        nro_cuota_current: parseInt10(String(row.nro_cuota_current ?? "")),
        nro_cuota_total: parseInt10(String(row.nro_cuota_total ?? "")),
        valor_cuota_mensual_clp: parseInt10(String(row.valor_cuota_mensual_clp ?? "")),
        valor_cuota_mensual_usd: parseUsdAmount(String(row.valor_cuota_mensual_usd ?? "")),
        interest_rate_text: String(row.interest_rate_text ?? "").trim() || null,
        tipo_cuota: String(row.tipo_cuota ?? "").trim() || null,
        dedupe_key: dedupeKeys[dedupeKeys.length - 1] ?? null,
        parser_row_id: String(row.row_id ?? "").trim() || null,
        raw_line: String(row.raw_line ?? "").trim() || null,
        origin_card_last4: originCardLast4,
      });
      const statementLineId = Number(ins.lastInsertRowid);
      if (
        maybeApplyAdditionalCardNoCuenta(accountId, statementLineId, originCardLast4, cardLast4)
      ) {
        additionalCardCategoriesApplied += 1;
      }
      lineCount += 1;
      linesInserted += 1;
    }
  }

  const restored = restoreCcExpenseCategories(accountId, categorySnap);

  return {
    statementCount,
    lineCount,
    linesInserted,
    linesSkippedDuplicate,
    linesSkippedFuzzyDuplicate,
    linesSkippedInstallmentOverlap,
    linesOriginCardPatched,
    additionalCardCategoriesApplied,
    categoriesRestored: restored.lineCategories + restored.uniquePurchases,
  };
}

/** Full account wipe + reload (CLI `import:cc-parsed --wipe`). */
export function importCcStatementsFromCsvRecords(
  accountId: number,
  records: CcStatementCsvRecord[]
): { statementCount: number; lineCount: number; categoriesRestored: number } {
  const r = importCcStatementsMerge(accountId, records, {
    replaceAll: true,
    skipGlobalDedupeKeys: false,
  });
  return {
    statementCount: r.statementCount,
    lineCount: r.lineCount,
    categoriesRestored: r.categoriesRestored,
  };
}
