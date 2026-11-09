import { canonicalCcLineDedupeKeys } from "./ccDedupeKey.js";
import { ccIssuerBySlug, ccIssuerForParserLayout, type CcIssuer } from "./ccIssuers.js";
import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import { ccStatementSourceKindOf, isListingSourceKind } from "./ccStatementSourceKind.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { classifyCcStatementLine, isGarbledUsdStatementMerchant } from "./ccStatementSection3.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { storedCardLineAmounts } from "./cards/statementStorage.js";
import {
  cardStatementKey,
  parseDdMmYyToIso,
  storedCardLineDate,
  isCcPaymentMerchant,
  isCcTraspasoDeudaMerchant,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";

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

/** A parsed-statement CSV header amount (Chilean style): an empty cell reads 0, text that is not a number throws. */
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

/**
 * Sum CLP movements by statement section. Non-installment lines are placed by
 * `classifyCcStatementLine`, whose rules (`ccStatementLineRules.json`) the parse-time
 * `cc_statement_reconcile.sum_parsed_sections` reads too.
 */
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

    const section = classifyCcStatementLine({
      currency: "clp",
      merchant: row.merchant,
      parser_layout: row.parser_layout,
      amount: row.amount_clp,
    });
    if (section === "operaciones") operaciones += row.amount_clp;
    else if (section === "cargos_abonos") cargos_abonos += row.amount_clp;
    else if (section === "mid_period_payments") midPeriodPayments += row.amount_clp;
  }

  return {
    parsed_operaciones: Math.round(operaciones),
    parsed_cargos_abonos: Math.round(cargos_abonos),
    parsed_cuotas: Math.round(cuotas),
    parsed_mid_period_payments: Math.round(midPeriodPayments),
    parsed_traspaso_nacional: 0,
  };
}

/** Sum movements for international USD statements (same line rules as {@link sumParsedSectionsClp}). */
export function sumParsedSectionsUsd(rows: readonly CcReconcileRow[]): CcParsedSectionSums {
  const seenDedupe = new Set<string>();
  let operaciones = 0;
  let cargos_abonos = 0;
  let traspaso_nacional = 0;

  for (const row of rows) {
    if (row.currency !== "usd") continue;
    if (isGarbledUsdStatementMerchant(row.merchant)) continue;
    const dk = reconcileMovementDedupeKey(row);
    if (dk) {
      if (seenDedupe.has(dk)) continue;
      seenDedupe.add(dk);
    }
    if (row.installment_flag) continue;

    const amt = row.amount_usd;
    const section = classifyCcStatementLine({
      currency: "usd",
      merchant: row.merchant,
      parser_layout: row.parser_layout,
      amount: amt,
    });
    if (section === "cargos_abonos") {
      cargos_abonos += amt;
      if (isCcTraspasoDeudaMerchant(row.merchant)) traspaso_nacional += amt;
    } else if (section === "operaciones") {
      operaciones += amt;
    }
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

/**
 * Does the sum of parsed operaciones match the statement's own printed total?
 *
 * USD is held to the cent. Its line amounts are exact two-decimal values, so the sum must equal the
 * printed total — there is nothing to accumulate rounding from. The previous band allowed the larger
 * of 15% or a flat US$35 (and reached for `TOL_CLP`, one *peso*, as a dollar floor), which is wide
 * enough to swallow an entire line: statement ·0781 23/07/2026 imported short of its printed
 * TOTAL OPERACIONES by one small subscription charge — one of a same-day twin pair — without failing. On a
 * card whose USD side is mostly small subscriptions, almost any dropped line fell inside that band.
 *
 * CLP keeps its wider band: those amounts are whole pesos in the millions and the legacy layouts
 * genuinely round.
 */
function closeEnoughOperaciones(actual: number, expected: number, currency: "clp" | "usd"): boolean {
  if (currency === "usd") return Math.abs(actual - expected) <= TOL_USD;
  const pct = 0.03;
  const floor = Math.min(5000, Math.max(500, Math.abs(expected) * pct));
  const band = Math.max(TOL_CLP, floor, Math.abs(expected) * pct);
  return Math.abs(actual - expected) <= band;
}

/**
 * The issuer whose «Monto total facturado» identity the statement follows: the one an
 * issuer-specific parser layout names (BCI Lider), else Santander's — the layout-less statements
 * (Santander, the CMR card's) reconcile by its candidates. The band is the issuer's
 * (`CC_ISSUERS[…].monto_facturado_tolerance_pct`).
 */
function reconcileIssuerForRows(rows: readonly CcReconcileRow[]): CcIssuer {
  for (const r of rows) {
    const issuer = ccIssuerForParserLayout(r.parser_layout);
    if (issuer) return issuer;
  }
  return ccIssuerBySlug("santander")!;
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
  const reconcileIssuer = reconcileIssuerForRows(facturadoRows);
  const bciLider = reconcileIssuer.slug === "bci";

  // The BCI `bci_incomplete_parse` hatch (<12 rows, or >8% gap vs pdf_total_operaciones) was
  // removed 2026-08-28: genuinely incomplete BCI parses already fail loudly at PARSE level
  // (the operaciones subtotal is a required check in cc_statement_reconcile.py), so at import
  // level the hatch only ever disarmed the monto_facturado gate — which is exactly what let
  // the 2026-08 ·0101 facturación import with 9 of 16 lines silently missing (the doubled
  // pdf_total_operaciones from the concat-text collection tripped the 8% arm). The BCI
  // monto_facturado check below is a hard gate now.

  if (currency === "clp" && monto != null && monto > 0) {
    if (bciLider) {
      const billed = parsed.parsed_operaciones + parsed.parsed_cargos_abonos;
      const delta = billed - monto;
      const tol = Math.max(TOL_CLP, Math.abs(monto) * reconcileIssuer.monto_facturado_tolerance_pct);
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
    const tol = Math.max(TOL_CLP, Math.abs(monto) * reconcileIssuer.monto_facturado_tolerance_pct);
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
      // A card can bill interest and fees (section 3) on top of the purchases.
      const ok =
        closeEnough(expected, deuda, TOL_USD) || closeEnough(expected + parsed.parsed_cargos_abonos, deuda, TOL_USD);
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

  /**
   * USD equivalent of the CLP `monto_facturado` check.
   *
   * Two shapes occur across the corpus and neither is wrong, so this accepts either rather than
   * forcing one identity: sometimes the billed total is just the period's charges (·0781 23/06/2026:
   * monto = compras, with a saldo anterior NOT carried), and sometimes it is those
   * charges plus the prior balance and its payment (·0161 24/01/2024: monto = compras + the
   * prior balance − its payment), and sometimes it nets a traspaso de deuda internacional (compras − traspaso = monto) —
   * an abono that moves the USD debt onto the CLP side of the same card, so no cash leaves the
   * checking account and the card's total debt is unchanged.
   * Forcing a single formula would fail legitimate statements — and because
   * `assertCcImportReconcilesOrThrow` gates writes, a false failure blocks a real import.
   *
   * This is a header-consistency check; the line-level guard is `header_compras_vs_operaciones`
   * above, which is what actually catches a dropped charge.
   */
  if (currency === "usd" && monto != null && monto > 0) {
    const saldo = header.saldo_anterior ?? 0;
    const abono = header.abono ?? 0;
    const comprasForMonto = compras ?? parsed.parsed_operaciones;
    const traspaso = parsed.parsed_traspaso_nacional;
    const candidates = [
      comprasForMonto,
      comprasForMonto + saldo + abono,
      comprasForMonto + traspaso,
      comprasForMonto + saldo + abono + traspaso,
      // A card can bill interest and fees (section 3) on top of the purchases.
      comprasForMonto + parsed.parsed_cargos_abonos,
      comprasForMonto + parsed.parsed_cargos_abonos + saldo + abono,
    ];
    const best = candidates.reduce((a, b) => (Math.abs(b - monto) < Math.abs(a - monto) ? b : a));
    checks.push({
      code: "monto_facturado",
      ok: candidates.some((c) => closeEnough(c, monto, TOL_USD)),
      expected: monto,
      actual: best,
      delta: monto - best,
      detail: "compras, or compras+saldo+abono, vs monto facturado",
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

function billingMonthOfStatement(statement: CardCanonicalStatement): string | null {
  return billingMonthForCcStatement({ statement_date: statement.close, period_to: statement.period_to });
}

function canonicalLineToReconcileRow(statement: CardCanonicalStatement, line: CardCanonicalLine): CcReconcileRow {
  const inst = line.installment;
  const { amount_clp, amount_usd } = storedCardLineAmounts(line);
  const sourcePdf = statement.document.trim();
  return {
    currency: statement.currency,
    installment_flag: inst != null,
    merchant: line.merchant || null,
    amount_clp,
    amount_usd: amount_usd ?? 0,
    valor_cuota_mensual_clp: inst?.cuota_amount ?? 0,
    valor_cuota_mensual_usd: 0,
    nro_cuota_current: inst?.number || null,
    nro_cuota_total: inst?.count || null,
    parser_layout: line.document.section || "compact",
    dedupe_key: line.document.dedupe_key,
    row_id: line.document.line_id,
    transaction_date: storedCardLineDate(line.printed_transaction_date, line.transaction_date),
    posting_date: storedCardLineDate(line.printed_posting_date, line.posting_date),
    from_web_paste: isListingSourceKind(ccStatementSourceKindOf(sourcePdf)),
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

function pickPreferredReconcilePurchase(prev: CcReconcileRow, next: CcReconcileRow): CcReconcileRow {
  const prevWeb = prev.from_web_paste === true;
  const nextWeb = next.from_web_paste === true;
  if (prevWeb !== nextWeb) return prevWeb ? next : prev;
  return prev;
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
  stmt: { currency: string; layout: string; source_pdf: string; source_kind: string }
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
    from_web_paste: isListingSourceKind(stmt.source_kind),
    source_pdf: stmt.source_pdf,
  };
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
    if (isListingSourceKind(st.source_kind)) continue;
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

/** A header amount as the reconcile reads it: dollars to the cent, pesos whole; null when not printed. */
function headerAmount(statement: CardCanonicalStatement, raw: number | null): number | null {
  if (raw == null) return null;
  if (statement.currency === "usd") return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : null;
  const n = Math.trunc(raw);
  return n !== 0 ? n : raw === 0 ? 0 : null;
}

function headerFromStatement(statement: CardCanonicalStatement | undefined): CcReconcileHeader {
  if (!statement) {
    return { monto_facturado: null, compras_cargos: null, source_pdf: null };
  }
  const h = statement.header;
  const montoRaw = h.monto_facturado ?? 0;
  const comprasRaw = h.compras_cargos ?? 0;
  const usd = statement.currency === "usd";
  const monto = usd ? (montoRaw > 0 ? Math.round(montoRaw * 100) / 100 : null) : Math.trunc(montoRaw) > 0 ? Math.trunc(montoRaw) : null;
  const compras = usd
    ? comprasRaw !== 0
      ? Math.round(comprasRaw * 100) / 100
      : null
    : Math.trunc(comprasRaw) > 0
      ? Math.trunc(comprasRaw)
      : null;
  return {
    monto_facturado: monto,
    compras_cargos: compras,
    source_pdf: statement.document.trim() || null,
    saldo_anterior: headerAmount(statement, h.saldo_anterior),
    monto_facturado_anterior: headerAmount(statement, h.monto_facturado_anterior),
    monto_pagado_anterior: headerAmount(statement, h.monto_pagado_anterior),
    abono: headerAmount(statement, h.abono),
    deuda_total: headerAmount(statement, h.deuda_total),
    pdf_total_operaciones: headerAmount(statement, h.pdf_total_operaciones),
  };
}

export function buildProjectedReconcileRows(
  accountId: number,
  billingMonth: string,
  incoming: readonly CardCanonicalStatement[],
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
    if (pdfReconcileOnly && isListingSourceKind(st.source_kind)) continue;
    const stmtKey = `${st.card_group}\t${st.source_pdf}\t${st.statement_date}`;
    if (replaceStatementKeys.has(stmtKey)) continue;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const row = dbLineToReconcileRow(line, st);
      const keys = canonicalCcLineDedupeKeys(st.card_group, {
        installment: row.installment_flag,
        dateIso: parseDdMmYyToIso(row.transaction_date ?? "") ?? parseDdMmYyToIso(row.posting_date ?? ""),
        merchant: row.merchant ?? "",
        amountClp: row.amount_clp,
        documentKey: row.dedupe_key,
      });
      addRow(row, keys, stmtKey);
    }
  }

  for (const statement of incoming) {
    if (billingMonthOfStatement(statement) !== billingMonth) continue;
    if (pdfReconcileOnly && isListingSourceKind(ccStatementSourceKindOf(statement.document))) continue;
    const stmtKey = cardStatementKey(statement);
    for (const line of statement.lines) {
      const row = canonicalLineToReconcileRow(statement, line);
      const keys = canonicalCcLineDedupeKeys(statement.card_group, {
        installment: row.installment_flag,
        dateIso: line.transaction_date ?? line.posting_date,
        merchant: row.merchant ?? "",
        amountClp: row.amount_clp,
        documentKey: row.dedupe_key,
      });
      addRow(row, keys, stmtKey);
    }
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

function affectedBillingMonths(incoming: readonly CardCanonicalStatement[]): string[] {
  const months = new Set<string>();
  for (const statement of incoming) {
    const bm = billingMonthOfStatement(statement);
    if (bm) months.add(bm);
  }
  return [...months].sort();
}

export function assertCcImportReconcilesOrThrow(
  accountId: number,
  incoming: readonly CardCanonicalStatement[],
  opts?: { replaceStatementKeys?: ReadonlySet<string> }
): CcImportReconcileResult[] {
  const replaceKeys = opts?.replaceStatementKeys ?? new Set<string>();
  const results: CcImportReconcileResult[] = [];

  for (const billingMonth of affectedBillingMonths(incoming)) {
    const incomingForMonth = incoming.filter((st) => billingMonthOfStatement(st) === billingMonth);
    const pdfIncoming = incomingForMonth.filter(
      (st) => st.lines.length > 0 && !isListingSourceKind(ccStatementSourceKindOf(st.document))
    );

    if (pdfIncoming.length === 0) {
      continue;
    }

    const projectedRows = buildProjectedReconcileRows(accountId, billingMonth, incoming, replaceKeys, {
      pdfReconcileOnly: true,
    });

    for (const sourcePdf of [...new Set(pdfIncoming.map((st) => st.document.trim()).filter(Boolean))].sort()) {
      const stmtPdfIncoming = pdfIncoming.filter((st) => st.document.trim() === sourcePdf);
      const reconcileCurrencies = [...new Set(stmtPdfIncoming.map((st) => st.currency))].sort();

      for (const headerCurrency of reconcileCurrencies) {
        const csvHeader = headerFromStatement(stmtPdfIncoming.find((st) => st.currency === headerCurrency));
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

