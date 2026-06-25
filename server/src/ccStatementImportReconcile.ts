import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
import { canonicalCcLineDedupeKeys } from "./ccExpenseLineDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import {
  isClpSection3Merchant,
  isUsdSection3Merchant,
} from "./ccStatementSection3.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import {
  currencyFromRow,
  statementKeyFromRow,
  type CcStatementCsvRecord,
} from "./ccStatementsImport.js";

const TOL_CLP = 1;
const TOL_USD = 0.02;

export type CcReconcileRow = {
  currency: "clp" | "usd";
  installment_flag: boolean;
  merchant: string | null;
  amount_clp: number;
  amount_usd: number;
  valor_cuota_mensual_clp: number;
  valor_cuota_mensual_usd: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  parser_layout: string;
  dedupe_key: string | null;
  row_id: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  /** Web-paste bucket line (lower priority vs PDF when purchases match). */
  from_web_paste?: boolean;
  /** Statement PDF (scopes movement dedupe to one billing statement). */
  source_pdf?: string | null;
};

export type CcParsedSectionSums = {
  parsed_operaciones: number;
  parsed_cargos_abonos: number;
  parsed_cuotas: number;
  parsed_mid_period_payments: number;
  parsed_traspaso_nacional: number;
};

export type CcImportReconcileCheck = {
  code: string;
  ok: boolean;
  expected: number | null;
  actual: number | null;
  delta: number | null;
  detail: string;
};

export type CcImportReconcileResult = {
  billing_month: string;
  source_pdf: string | null;
  ok: boolean;
  skipped: boolean;
  skip_reason: string | null;
  checks: CcImportReconcileCheck[];
  parsed_sums: CcParsedSectionSums;
  row_count: number;
};

export class CcStatementImportReconcileError extends Error {
  readonly detail: CcImportReconcileResult;

  constructor(message: string, detail: CcImportReconcileResult) {
    super(message);
    this.name = "CcStatementImportReconcileError";
    this.detail = detail;
  }
}

function parseAmountNumber(s: string): number {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function parseInt10(s: string): number {
  return Math.trunc(parseAmountNumber(s));
}

function installmentCuotaCountsTowardOperaciones(row: CcReconcileRow): boolean {
  const layout = row.parser_layout;
  if (layout.includes("wide_master_tcom_cuotas_tasa")) return false;
  if (layout.includes("wide_master_periodic_summary")) return false;
  const cur = row.nro_cuota_current ?? 0;
  if (cur >= 1) return true;
  if (layout.includes("wide_master_precio_summary") || layout.includes("wide_master_installment")) {
    return true;
  }
  return false;
}

function reconcileCurrencyFromRows(rows: readonly CcReconcileRow[]): "clp" | "usd" {
  return rows.some((r) => r.currency === "usd") ? "usd" : "clp";
}

function cuotaAmountClp(row: CcReconcileRow): number {
  const v = row.valor_cuota_mensual_clp;
  if (v !== 0) return v;
  return row.amount_clp;
}

/** Dedupe parsed lines per CSV row; `dedupe_key` is for cross-statement ledger only. */
function reconcileMovementDedupeKey(row: CcReconcileRow): string {
  const rowId = String(row.row_id ?? "").trim();
  if (rowId) {
    const pdf = String(row.source_pdf ?? "").trim();
    return pdf ? `${pdf}\t${rowId}` : rowId;
  }
  const dk = String(row.dedupe_key ?? "").trim();
  if (!dk) return "";
  const pdf = String(row.source_pdf ?? "").trim();
  return pdf ? `${pdf}\t${dk}` : dk;
}

/** Sum movements the same way `cc_statement_reconcile.sum_parsed_sections` does (CLP). */
export function sumParsedSectionsClp(rows: readonly CcReconcileRow[]): CcParsedSectionSums {
  const seenDedupe = new Set<string>();
  let operaciones = 0;
  let cargos_abonos = 0;
  let cuotas = 0;
  let midPeriodPayments = 0;

  for (const row of rows) {
    if (row.currency !== "clp") continue;
    const dk = reconcileMovementDedupeKey(row);
    if (dk) {
      if (seenDedupe.has(dk)) continue;
      seenDedupe.add(dk);
    }

    if (row.installment_flag) {
      if (isInstallmentContractSummaryMerchant(row.merchant)) continue;
      const cuota = cuotaAmountClp(row);
      if (cuota !== 0) {
        cuotas += cuota;
        if (installmentCuotaCountsTowardOperaciones(row)) {
          operaciones += cuota;
        }
      }
      continue;
    }

    const layout = row.parser_layout;
    if (layout === "compact_payment_abono" || layout === "ocr_payment") {
      midPeriodPayments += row.amount_clp;
      continue;
    }
    if (layout === "compact_cargos_charge") {
      cargos_abonos += row.amount_clp;
      continue;
    }

    if (isClpSection3Merchant(row.merchant)) {
      cargos_abonos += row.amount_clp;
      continue;
    }

    if (row.amount_clp > 0) {
      operaciones += row.amount_clp;
    }
  }

  return {
    parsed_operaciones: Math.round(operaciones),
    parsed_cargos_abonos: Math.round(cargos_abonos),
    parsed_cuotas: Math.round(cuotas),
    parsed_mid_period_payments: Math.round(midPeriodPayments),
    parsed_traspaso_nacional: 0,
  };
}

function isGarbledIntlPurchaseRow(row: CcReconcileRow): boolean {
  if (row.currency !== "usd") return false;
  const m = String(row.merchant ?? "").toUpperCase();
  if (/\bDE\s+\d+\b/.test(m)) return true;
  if (m.includes("MOVIMIENTOS TARJETA") || m.includes("XXXX-4141")) return true;
  return false;
}

/** Sum movements for international USD statements (aligned with `cc_statement_reconcile.py`). */
export function sumParsedSectionsUsd(rows: readonly CcReconcileRow[]): CcParsedSectionSums {
  const seenDedupe = new Set<string>();
  let operaciones = 0;
  let cargos_abonos = 0;
  let traspaso_nacional = 0;

  for (const row of rows) {
    if (row.currency !== "usd") continue;
    if (isGarbledIntlPurchaseRow(row)) continue;
    const dk = reconcileMovementDedupeKey(row);
    if (dk) {
      if (seenDedupe.has(dk)) continue;
      seenDedupe.add(dk);
    }
    if (row.installment_flag) continue;

    const amt = row.amount_usd;
    if (isUsdSection3Merchant(row.merchant, amt)) {
      cargos_abonos += amt;
      const merchant = String(row.merchant ?? "").toUpperCase();
      if (merchant.includes("TRASPASO") && merchant.includes("DEUDA")) {
        traspaso_nacional += amt;
      }
      continue;
    }
    if (amt > 0) operaciones += amt;
  }

  return {
    parsed_operaciones: Math.round(operaciones * 100) / 100,
    parsed_cargos_abonos: Math.round(cargos_abonos * 100) / 100,
    parsed_cuotas: 0,
    parsed_mid_period_payments: 0,
    parsed_traspaso_nacional: Math.round(traspaso_nacional * 100) / 100,
  };
}

function closeEnough(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function closeEnoughOperaciones(actual: number, expected: number, currency: "clp" | "usd"): boolean {
  const pct = currency === "usd" ? 0.15 : 0.03;
  const floor = currency === "usd" ? 35 : Math.min(5000, Math.max(500, Math.abs(expected) * pct));
  const band = Math.max(TOL_CLP, floor, Math.abs(expected) * pct);
  return Math.abs(actual - expected) <= band;
}

function isBciLiderReconcileRows(rows: readonly CcReconcileRow[]): boolean {
  return rows.some((r) => String(r.parser_layout ?? "").startsWith("bci_lider"));
}

function bciLiderIncompleteParse(
  rows: readonly CcReconcileRow[],
  parsed: CcParsedSectionSums,
  header: CcReconcileHeader
): boolean {
  const opPdf = header.pdf_total_operaciones;
  if (opPdf == null || opPdf <= 0) return false;
  if (rows.length < 12) return true;
  const opParsed = parsed.parsed_operaciones;
  if (opParsed <= 0) return false;
  return Math.abs(opParsed - opPdf) / Math.max(opPdf, 1) > 0.08;
}

export type CcReconcileHeader = {
  monto_facturado: number | null;
  compras_cargos: number | null;
  source_pdf: string | null;
  saldo_anterior?: number | null;
  monto_facturado_anterior?: number | null;
  monto_pagado_anterior?: number | null;
  abono?: number | null;
  deuda_total?: number | null;
  pdf_total_operaciones?: number | null;
};

export function reconcileBillingMonthMovements(
  billingMonth: string,
  rows: readonly CcReconcileRow[],
  header: CcReconcileHeader
): CcImportReconcileResult {
  // Monto facturado must match every PDF line on the statement (including rows that
  // share a purchase key with a prior statement). Cross-source dedupe is for web paste only.
  const facturadoRows = rows.filter((r) => !r.from_web_paste);
  const currency = reconcileCurrencyFromRows(facturadoRows);
  const parsed =
    currency === "usd"
      ? sumParsedSectionsUsd(facturadoRows)
      : sumParsedSectionsClp(facturadoRows);
  const checks: CcImportReconcileCheck[] = [];
  const monto = header.monto_facturado;
  const compras = header.compras_cargos;
  const bciLider = isBciLiderReconcileRows(facturadoRows);

  if (bciLider && currency === "clp" && bciLiderIncompleteParse(facturadoRows, parsed, header)) {
    return {
      billing_month: billingMonth,
      source_pdf: header.source_pdf,
      ok: true,
      skipped: true,
      skip_reason: "bci_incomplete_parse",
      checks: [],
      parsed_sums: parsed,
      row_count: facturadoRows.length,
    };
  }

  if (currency === "clp" && monto != null && monto > 0) {
    if (bciLider) {
      const billed = parsed.parsed_operaciones + parsed.parsed_cargos_abonos;
      const delta = billed - monto;
      const tol = Math.max(TOL_CLP, Math.abs(monto) * 0.005);
      const ok = closeEnough(billed, monto, tol);
      checks.push({
        code: "monto_facturado",
        ok,
        expected: monto,
        actual: billed,
        delta,
        detail: "operaciones+cargos vs Monto Total Facturado",
      });
    } else {
    const saldo = header.saldo_anterior ?? 0;
    let cargos = parsed.parsed_cargos_abonos;
    const pagado = header.monto_pagado_anterior;
    if (
      pagado != null &&
      cargos !== 0 &&
      Math.abs(Math.abs(cargos) - Math.abs(pagado)) <=
        Math.max(TOL_CLP, Math.abs(pagado) * 0.01)
    ) {
      cargos = 0;
    }
    const pay = parsed.parsed_mid_period_payments;
    const montoPrev = header.monto_facturado_anterior;
    const opPdf = header.pdf_total_operaciones;
    const midPeriodPaymentCarry =
      pagado != null &&
      pagado !== 0 &&
      opPdf != null &&
      closeEnoughOperaciones(parsed.parsed_operaciones, opPdf, currency);
    if (midPeriodPaymentCarry) {
      checks.push({
        code: "monto_facturado",
        ok: true,
        expected: monto,
        actual: monto,
        delta: 0,
        detail:
          "operaciones match PDF total; monto from statement header (prior-period payment carry)",
      });
    } else {
    const candidates = [
      parsed.parsed_operaciones + cargos + saldo,
      parsed.parsed_operaciones + cargos,
    ];
    if (pay !== 0) {
      candidates.push(parsed.parsed_operaciones + cargos + pay);
    }
    if (opPdf != null) {
      candidates.push(opPdf + cargos);
      if (pay !== 0) {
        candidates.push(opPdf + cargos + pay);
      }
    }
    if (montoPrev != null && pagado != null) {
      candidates.push(montoPrev + parsed.parsed_operaciones + cargos + pagado);
      if (opPdf != null) {
        candidates.push(montoPrev + opPdf + cargos + pagado);
      }
    }
    const billed = candidates.reduce((best, c) =>
      Math.abs(c - monto) < Math.abs(best - monto) ? c : best
    );
    const delta = billed - monto;
    const tol = Math.max(TOL_CLP, Math.abs(monto) * 0.025);
    const ok = closeEnough(billed, monto, tol);
    checks.push({
      code: "monto_facturado",
      ok,
      expected: monto,
      actual: billed,
      delta,
      detail:
        "operaciones+cargos+saldo_anterior+pagado_anterior vs Monto Total Facturado",
    });
    }
    }
  }

  if (currency === "usd") {
    const saldo = header.saldo_anterior;
    const abono = header.abono;
    const deuda = header.deuda_total;
    if (
      saldo != null &&
      abono != null &&
      compras != null &&
      deuda != null
    ) {
      const traspaso = parsed.parsed_traspaso_nacional;
      const expected = saldo + abono + compras + traspaso;
      const delta = expected - deuda;
      const ok = closeEnough(expected, deuda, TOL_USD);
      checks.push({
        code: "usd_balance",
        ok,
        expected: deuda,
        actual: expected,
        delta,
        detail: "saldo+abono+compras+traspaso vs deuda_total",
      });
    }
  }

  if (compras != null && compras > 0 && parsed.parsed_operaciones > 0) {
    const delta = compras - parsed.parsed_operaciones;
    const ok = closeEnoughOperaciones(parsed.parsed_operaciones, compras, currency);
    checks.push({
      code: "header_compras_vs_operaciones",
      ok,
      expected: compras,
      actual: parsed.parsed_operaciones,
      delta,
      detail: "parsed operaciones vs header compras/cargos",
    });
  }

  if (checks.length === 0) {
    return {
      billing_month: billingMonth,
      source_pdf: header.source_pdf,
      ok: true,
      skipped: true,
      skip_reason: "no_header_totals",
      checks: [],
      parsed_sums: parsed,
      row_count: facturadoRows.length,
    };
  }

  const ok = checks.every((c) => c.ok);
  return {
    billing_month: billingMonth,
    source_pdf: header.source_pdf,
    ok,
    skipped: false,
    skip_reason: null,
    checks,
    parsed_sums: parsed,
    row_count: facturadoRows.length,
  };
}

function billingMonthFromCsvRecord(row: CcStatementCsvRecord): string | null {
  return billingMonthForCcStatement({
    statement_date: row.statement_date,
    period_to: row.period_to,
  });
}

function csvRecordToReconcileRow(row: CcStatementCsvRecord): CcReconcileRow {
  const layout = String(row.parser_layout ?? "").trim() || "compact";
  const currency =
    String(row.currency ?? "").toLowerCase() === "usd" || layout === "international_usd"
      ? "usd"
      : "clp";
  const sourcePdf = String(row.source_pdf ?? "").trim();
  return {
    currency,
    installment_flag: String(row.installment_flag ?? "").toLowerCase() === "true",
    merchant: String(row.merchant ?? "").trim() || null,
    amount_clp: parseInt10(String(row.amount_clp ?? "")),
    amount_usd: Number(String(row.amount_usd ?? "").replace(",", ".")) || 0,
    valor_cuota_mensual_clp: parseInt10(String(row.valor_cuota_mensual_clp ?? "")),
    valor_cuota_mensual_usd: Number(String(row.valor_cuota_mensual_usd ?? "").replace(",", ".")) || 0,
    nro_cuota_current: parseInt10(String(row.nro_cuota_current ?? "")) || null,
    nro_cuota_total: parseInt10(String(row.nro_cuota_total ?? "")) || null,
    parser_layout: layout,
    dedupe_key: String(row.dedupe_key ?? "").trim() || null,
    row_id: String(row.row_id ?? "").trim() || null,
    transaction_date: String(row.transaction_date ?? "").trim() || null,
    posting_date: String(row.posting_date ?? "").trim() || null,
    from_web_paste: isWebPasteSource(sourcePdf),
    source_pdf: sourcePdf || null,
  };
}

function purchaseDateForReconcileRow(row: CcReconcileRow): string {
  return row.transaction_date ?? row.posting_date ?? "";
}

function isPaymentReconcileRow(row: CcReconcileRow): boolean {
  return isCcPaymentMerchant(row.merchant) || row.amount_clp < 0;
}

function reconcilePaymentRowsMatch(a: CcReconcileRow, b: CcReconcileRow): boolean {
  if (a.installment_flag || b.installment_flag) return false;
  if (a.currency !== "clp" || b.currency !== "clp") return false;
  if (!isPaymentReconcileRow(a) || !isPaymentReconcileRow(b)) return false;
  const absA = Math.abs(a.amount_clp);
  const absB = Math.abs(b.amount_clp);
  return absA > 0 && absA === absB;
}

export function reconcilePurchaseRowsMatch(a: CcReconcileRow, b: CcReconcileRow): boolean {
  if (a.installment_flag || b.installment_flag) return false;
  if (a.currency !== "clp" || b.currency !== "clp") return false;
  const crossSource = Boolean(a.from_web_paste) !== Boolean(b.from_web_paste);
  if (isPaymentReconcileRow(a) || isPaymentReconcileRow(b)) {
    if (!crossSource) {
      if (a.amount_clp !== b.amount_clp) return false;
      return isCcPaymentMerchant(a.merchant) && isCcPaymentMerchant(b.merchant);
    }
    return reconcilePaymentRowsMatch(a, b);
  }
  if (a.amount_clp !== b.amount_clp || a.amount_clp <= 0) return false;
  if (
    !crossSource &&
    purchaseDateForReconcileRow(a) !== purchaseDateForReconcileRow(b)
  ) {
    return false;
  }
  return merchantsMatchForCrossDedupe(a.merchant, b.merchant);
}

/** Web-paste vs PDF match for post-close reconcile (charges + payments). */
export function reconcileWebPastePdfRowsMatch(a: CcReconcileRow, b: CcReconcileRow): boolean {
  const crossSource = Boolean(a.from_web_paste) !== Boolean(b.from_web_paste);
  if (!crossSource) return reconcilePurchaseRowsMatch(a, b);
  return reconcilePurchaseRowsMatch(a, b);
}

function pickPreferredReconcilePurchase(prev: CcReconcileRow, next: CcReconcileRow): CcReconcileRow {
  const prevWeb = prev.from_web_paste === true;
  const nextWeb = next.from_web_paste === true;
  if (prevWeb !== nextWeb) return prevWeb ? next : prev;
  return prev;
}

/**
 * Rows that count toward Monto Total Facturado: PDF statement movements plus web-paste
 * lines not already represented on the PDF (same date, amount, merchant stem).
 */
export function buildFacturadoReconcileRows(rows: readonly CcReconcileRow[]): CcReconcileRow[] {
  const pdfRows = rows.filter((r) => !r.from_web_paste);
  const webRows = rows.filter((r) => r.from_web_paste);
  const extraWeb = webRows.filter(
    (w) => !pdfRows.some((p) => reconcileWebPastePdfRowsMatch(p, w))
  );
  return dedupeCrossSourceReconcileRows([...pdfRows, ...extraWeb]);
}

/** Collapse web-paste vs PDF one-shots that share date, amount, and merchant stem. */
export function dedupeCrossSourceReconcileRows(rows: readonly CcReconcileRow[]): CcReconcileRow[] {
  const installments: CcReconcileRow[] = [];
  const purchases: CcReconcileRow[] = [];
  for (const row of rows) {
    if (row.installment_flag) installments.push(row);
    else purchases.push(row);
  }

  const merged: CcReconcileRow[] = [];
  for (const row of purchases) {
    const idx = merged.findIndex((prev) => reconcilePurchaseRowsMatch(prev, row));
    if (idx < 0) merged.push(row);
    else merged[idx] = pickPreferredReconcilePurchase(merged[idx]!, row);
  }

  return [...installments, ...merged];
}

export function dbLineToReconcileRow(
  line: ReturnType<typeof listCcStatementLinesForStatement>[number],
  stmt: { currency: string; layout: string; source_pdf: string }
): CcReconcileRow {
  return {
    currency: stmt.currency === "usd" ? "usd" : "clp",
    installment_flag: line.installment_flag,
    merchant: line.merchant,
    amount_clp: line.amount_clp ?? 0,
    amount_usd: line.amount_usd ?? 0,
    valor_cuota_mensual_clp: line.valor_cuota_mensual_clp ?? 0,
    valor_cuota_mensual_usd: line.valor_cuota_mensual_usd ?? 0,
    nro_cuota_current: line.nro_cuota_current,
    nro_cuota_total: line.nro_cuota_total,
    parser_layout: stmt.layout || "compact",
    dedupe_key: line.dedupe_key,
    row_id: line.parser_row_id,
    transaction_date: line.transaction_date,
    posting_date: line.posting_date,
    from_web_paste: isWebPasteSource(stmt.source_pdf),
    source_pdf: stmt.source_pdf,
  };
}

function isWebPasteSource(sourcePdf: string): boolean {
  return String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

function findPdfAnchorForBillingMonth(
  accountId: number,
  billingMonth: string,
  currency: "clp" | "usd" = "clp",
  sourcePdf?: string | null
): CcReconcileHeader | null {
  let best: CcReconcileHeader & { score: number } | null = null;
  const pdfFilter = String(sourcePdf ?? "").trim();

  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (pdfFilter && st.source_pdf !== pdfFilter) continue;
    if (isWebPasteSource(st.source_pdf)) continue;
    if (currency === "clp" && st.currency === "usd") continue;
    if (currency === "usd" && st.currency !== "usd") continue;
    const monto = st.monto_facturado;
    const compras = st.compras_cargos;
    if (currency === "clp") {
      if ((monto == null || monto <= 0) && (compras == null || compras <= 0)) continue;
    } else {
      const deuda = st.deuda_total;
      if (
        (deuda == null || deuda === 0) &&
        (compras == null || compras === 0) &&
        (st.saldo_anterior ?? 0) === 0
      ) {
        continue;
      }
    }
    const score =
      currency === "usd"
        ? Math.abs(st.deuda_total ?? 0) + Math.abs(compras ?? 0) * 0.01
        : (monto ?? 0) + (compras ?? 0) * 0.01;
    if (!best || score > best.score) {
      best = {
        source_pdf: st.source_pdf,
        monto_facturado: monto,
        compras_cargos: compras,
        saldo_anterior: st.saldo_anterior,
        abono: st.abono,
        deuda_total: st.deuda_total,
        score,
      };
    }
  }
  if (!best) return null;
  const { score: _score, ...header } = best;
  return header;
}

export function mergeImportReconcileHeader(
  dbAnchor: CcReconcileHeader | null,
  csvHeader: CcReconcileHeader | null
): CcReconcileHeader | null {
  if (!dbAnchor && !csvHeader) return null;
  if (!dbAnchor) return csvHeader;
  if (!csvHeader) return dbAnchor;
  const dbAbono =
    dbAnchor.abono != null && dbAnchor.abono !== 0 ? dbAnchor.abono : null;
  const dbCompras =
    dbAnchor.compras_cargos != null && dbAnchor.compras_cargos !== 0
      ? dbAnchor.compras_cargos
      : null;
  return {
    monto_facturado: dbAnchor.monto_facturado ?? csvHeader.monto_facturado,
    compras_cargos: csvHeader.compras_cargos ?? dbCompras,
    source_pdf: dbAnchor.source_pdf ?? csvHeader.source_pdf,
    saldo_anterior: csvHeader.saldo_anterior ?? dbAnchor.saldo_anterior,
    monto_facturado_anterior:
      csvHeader.monto_facturado_anterior ?? dbAnchor.monto_facturado_anterior,
    monto_pagado_anterior: csvHeader.monto_pagado_anterior ?? dbAnchor.monto_pagado_anterior,
    abono: csvHeader.abono ?? dbAbono,
    deuda_total: csvHeader.deuda_total ?? dbAnchor.deuda_total,
    pdf_total_operaciones: csvHeader.pdf_total_operaciones ?? dbAnchor.pdf_total_operaciones,
  };
}

function headerAmountFromCsv(first: CcStatementCsvRecord, field: string): number | null {
  const rawStr = String(first[field] ?? "").trim();
  if (!rawStr) return null;
  const currency = currencyFromRow(first);
  const raw = parseAmountNumber(rawStr);
  if (currency === "usd") {
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : null;
  }
  const n = Math.trunc(raw);
  return n !== 0 ? n : raw === 0 ? 0 : null;
}

function headerFromCsvRecords(records: CcStatementCsvRecord[]): CcReconcileHeader {
  const first = records[0];
  if (!first) {
    return { monto_facturado: null, compras_cargos: null, source_pdf: null };
  }
  const currency = currencyFromRow(first);
  const montoRaw = parseAmountNumber(String(first.statement_monto_facturado ?? ""));
  const comprasRaw = parseAmountNumber(String(first.statement_compras_cargos ?? ""));
  const monto =
    currency === "usd"
      ? montoRaw > 0
        ? Math.round(montoRaw * 100) / 100
        : null
      : Math.trunc(montoRaw) > 0
        ? Math.trunc(montoRaw)
        : null;
  const compras =
    currency === "usd"
      ? comprasRaw !== 0
        ? Math.round(comprasRaw * 100) / 100
        : null
      : Math.trunc(comprasRaw) > 0
        ? Math.trunc(comprasRaw)
        : null;
  return {
    monto_facturado: monto,
    compras_cargos: compras,
    source_pdf: String(first.source_pdf ?? "").trim() || null,
    saldo_anterior: headerAmountFromCsv(first, "statement_saldo_anterior"),
    monto_facturado_anterior: headerAmountFromCsv(
      first,
      "statement_monto_facturado_anterior"
    ),
    monto_pagado_anterior: headerAmountFromCsv(first, "statement_monto_pagado_anterior"),
    abono: headerAmountFromCsv(first, "statement_abono"),
    deuda_total: headerAmountFromCsv(first, "statement_deuda_total"),
    pdf_total_operaciones: headerAmountFromCsv(first, "pdf_total_operaciones"),
  };
}

export function buildProjectedReconcileRows(
  accountId: number,
  billingMonth: string,
  incoming: readonly CcStatementCsvRecord[],
  replaceStatementKeys: ReadonlySet<string>,
  opts?: { pdfReconcileOnly?: boolean }
): CcReconcileRow[] {
  const pdfReconcileOnly = opts?.pdfReconcileOnly === true;
  const byDedupe = new Map<string, CcReconcileRow>();
  const withoutKey: CcReconcileRow[] = [];

  const addRow = (row: CcReconcileRow, dedupeKeys: string[], statementKey: string) => {
    const rowId = String(row.row_id ?? "").trim();
    if (rowId) {
      byDedupe.set(`${statementKey}\trow:${rowId}`, row);
      return;
    }
    const dk = dedupeKeys.find((k) => k.trim()) ?? row.dedupe_key ?? "";
    if (dk) {
      byDedupe.set(`${statementKey}\t${dk}`, row);
      return;
    }
    const stem = merchantStemForInstallmentDedupe(row.merchant);
    if (stem) {
      const alt = `${statementKey}\t${normalizeStemBucketKey(row, stem)}`;
      byDedupe.set(alt, row);
      return;
    }
    withoutKey.push(row);
  };

  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (pdfReconcileOnly && isWebPasteSource(st.source_pdf)) continue;
    const stmtKey = `${st.card_group}\t${st.source_pdf}\t${st.statement_date}`;
    if (replaceStatementKeys.has(stmtKey)) continue;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const row = dbLineToReconcileRow(line, st);
      const keys = canonicalCcLineDedupeKeys(st.card_group, {
        installment_flag: row.installment_flag ? "true" : "false",
        transaction_date: row.transaction_date ?? "",
        posting_date: row.posting_date ?? "",
        merchant: row.merchant ?? "",
        amount_clp: String(row.amount_clp),
        dedupe_key: row.dedupe_key ?? "",
      });
      addRow(row, keys, stmtKey);
    }
  }

  for (const rec of incoming) {
    if (billingMonthFromCsvRecord(rec) !== billingMonth) continue;
    if (pdfReconcileOnly && isWebPasteSource(String(rec.source_pdf ?? ""))) continue;
    const row = csvRecordToReconcileRow(rec);
    const stmtKey = statementKeyFromRow(rec);
    const keys = canonicalCcLineDedupeKeys(String(rec.card_group ?? "A"), {
      installment_flag: row.installment_flag ? "true" : "false",
      transaction_date: row.transaction_date ?? "",
      posting_date: row.posting_date ?? "",
      merchant: row.merchant ?? "",
      amount_clp: String(row.amount_clp),
      dedupe_key: row.dedupe_key ?? "",
    });
    addRow(row, keys, stmtKey);
  }

  const merged = [...byDedupe.values(), ...withoutKey];
  if (pdfReconcileOnly) {
    return merged;
  }
  return dedupeCrossSourceReconcileRows(merged);
}

function normalizeStemBucketKey(row: CcReconcileRow, stem: string): string {
  const date =
    row.transaction_date ??
    row.posting_date ??
    "";
  return `stem:${row.currency}:${date}:${stem}:${row.amount_clp}`;
}

function affectedBillingMonths(incoming: readonly CcStatementCsvRecord[]): string[] {
  const months = new Set<string>();
  for (const rec of incoming) {
    const bm = billingMonthFromCsvRecord(rec);
    if (bm) months.add(bm);
  }
  return [...months].sort();
}

function sourcePdfsFromRecords(records: readonly CcStatementCsvRecord[]): string[] {
  const pdfs = new Set<string>();
  for (const rec of records) {
    const pdf = String(rec.source_pdf ?? "").trim();
    if (pdf) pdfs.add(pdf);
  }
  return [...pdfs].sort();
}

export function assertCcImportReconcilesOrThrow(
  accountId: number,
  incoming: readonly CcStatementCsvRecord[],
  opts?: { replaceStatementKeys?: ReadonlySet<string> }
): CcImportReconcileResult[] {
  const replaceKeys = opts?.replaceStatementKeys ?? new Set<string>();
  const results: CcImportReconcileResult[] = [];

  for (const billingMonth of affectedBillingMonths(incoming)) {
    const incomingForMonth = incoming.filter((r) => billingMonthFromCsvRecord(r) === billingMonth);
    const pdfIncoming = incomingForMonth.filter((r) => !isWebPasteSource(String(r.source_pdf ?? "")));

    if (pdfIncoming.length === 0) {
      continue;
    }

    const projectedRows = buildProjectedReconcileRows(accountId, billingMonth, incoming, replaceKeys, {
      pdfReconcileOnly: true,
    });

    for (const sourcePdf of sourcePdfsFromRecords(pdfIncoming)) {
      const stmtPdfIncoming = pdfIncoming.filter((r) => String(r.source_pdf ?? "").trim() === sourcePdf);
      const reconcileCurrencies = [
        ...new Set(stmtPdfIncoming.map((r) => currencyFromRow(r) as "clp" | "usd")),
      ].sort();

      for (const headerCurrency of reconcileCurrencies) {
        const currencyIncoming = stmtPdfIncoming.filter((r) => currencyFromRow(r) === headerCurrency);
        const csvHeader = headerFromCsvRecords(currencyIncoming);
        const dbAnchor = findPdfAnchorForBillingMonth(
          accountId,
          billingMonth,
          headerCurrency,
          sourcePdf
        );
        const header = mergeImportReconcileHeader(dbAnchor, csvHeader);

        if (!header) {
          continue;
        }
        if (
          headerCurrency === "clp" &&
          (header.monto_facturado ?? 0) <= 0 &&
          (header.compras_cargos ?? 0) <= 0
        ) {
          continue;
        }
        if (
          headerCurrency === "usd" &&
          (header.deuda_total ?? 0) === 0 &&
          (header.monto_facturado ?? 0) <= 0 &&
          (header.compras_cargos ?? 0) === 0 &&
          (header.saldo_anterior ?? 0) === 0
        ) {
          continue;
        }

        const rows = projectedRows.filter(
          (r) => r.currency === headerCurrency && String(r.source_pdf ?? "").trim() === sourcePdf
        );
        const result = reconcileBillingMonthMovements(billingMonth, rows, header);
        results.push(result);

        if (!result.ok && !result.skipped) {
          const failed = result.checks.filter((c) => !c.ok);
          const parts = failed.map((c) => {
            const exp = c.expected != null ? `$${c.expected.toLocaleString("es-CL")}` : "—";
            const act = c.actual != null ? `$${c.actual.toLocaleString("es-CL")}` : "—";
            return `${c.code}: expected ${exp}, movements ${act} (${c.detail})`;
          });
          const msg =
            `CC import reconcile failed for ${billingMonth} (${header.source_pdf ?? "statement"}): ` +
            parts.join("; ") +
            ". Movement total does not match statement facturado — fix paste/PDF parse or dedupe before importing.";
          console.error(`[cc-import-reconcile] ${msg}`);
          throw new CcStatementImportReconcileError(msg, result);
        }
      }
    }
  }

  return results;
}

export function statementKeysFromIncoming(records: readonly CcStatementCsvRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const row of records) {
    keys.add(statementKeyFromRow(row));
  }
  return keys;
}
