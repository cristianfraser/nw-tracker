import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
import { canonicalCcLineDedupeKeys } from "./ccExpenseLineDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import {
  currencyFromRow,
  statementKeyFromRow,
  type CcStatementCsvRecord,
} from "./ccStatementsImport.js";

const TOL_CLP = 1;
const TOL_USD = 0.02;

const RE_CLP_SECTION3_CHARGE =
  /IMPUESTOS|INTERESES|TRASPASO|COMISION|IMPTO\.|SERVICIO\s+USO\s+INTERNACIONAL|IVA\s+USO\s+INTERNACIONAL|NOTA\s+DE\s+CREDITO|DCTO\s+COM|ADM\|MANTENCION/i;

const RE_USD_SECTION3 =
  /IMPUESTOS|INTERESES|TRASPASO|COMISION|ABONO\s+DE\s+DIVISAS|SERVICIO|NOTA\s+DE\s+CREDITO/i;

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
};

export type CcParsedSectionSums = {
  parsed_operaciones: number;
  parsed_cargos_abonos: number;
  parsed_cuotas: number;
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

function isClpSection3Line(merchant: string | null): boolean {
  const m = String(merchant ?? "").trim();
  if (isCcPaymentMerchant(m)) return false;
  return RE_CLP_SECTION3_CHARGE.test(m);
}

function isUsdSection3Line(merchant: string | null, amountUsd: number): boolean {
  const m = String(merchant ?? "").trim().toUpperCase();
  if (!m) return false;
  if (isCcPaymentMerchant(m) || m.includes("ABONO DE DIVISAS")) return true;
  if (amountUsd <= 0) return true;
  return RE_USD_SECTION3.test(m);
}

function reconcileCurrencyFromRows(rows: readonly CcReconcileRow[]): "clp" | "usd" {
  return rows.some((r) => r.currency === "usd") ? "usd" : "clp";
}

function cuotaAmountClp(row: CcReconcileRow): number {
  const v = row.valor_cuota_mensual_clp;
  if (v !== 0) return v;
  return row.amount_clp;
}

/** Sum movements the same way `cc_statement_reconcile.sum_parsed_sections` does (CLP). */
export function sumParsedSectionsClp(rows: readonly CcReconcileRow[]): CcParsedSectionSums {
  const seenDedupe = new Set<string>();
  let operaciones = 0;
  let cargos_abonos = 0;
  let cuotas = 0;

  for (const row of rows) {
    if (row.currency !== "clp") continue;
    const dk = String(row.dedupe_key ?? row.row_id ?? "").trim();
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

    if (isClpSection3Line(row.merchant)) {
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
  };
}

/** Sum movements for international USD statements (aligned with `cc_statement_reconcile.py`). */
export function sumParsedSectionsUsd(rows: readonly CcReconcileRow[]): CcParsedSectionSums {
  const seenDedupe = new Set<string>();
  let operaciones = 0;
  let cargos_abonos = 0;

  for (const row of rows) {
    if (row.currency !== "usd") continue;
    const dk = String(row.dedupe_key ?? row.row_id ?? "").trim();
    if (dk) {
      if (seenDedupe.has(dk)) continue;
      seenDedupe.add(dk);
    }
    if (row.installment_flag) continue;

    const amt = row.amount_usd;
    if (isUsdSection3Line(row.merchant, amt)) {
      cargos_abonos += amt;
      continue;
    }
    if (amt > 0) operaciones += amt;
  }

  return {
    parsed_operaciones: Math.round(operaciones * 100) / 100,
    parsed_cargos_abonos: Math.round(cargos_abonos * 100) / 100,
    parsed_cuotas: 0,
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

export type CcReconcileHeader = {
  monto_facturado: number | null;
  compras_cargos: number | null;
  source_pdf: string | null;
  saldo_anterior?: number | null;
  abono?: number | null;
  deuda_total?: number | null;
};

export function reconcileBillingMonthMovements(
  billingMonth: string,
  rows: readonly CcReconcileRow[],
  header: CcReconcileHeader
): CcImportReconcileResult {
  const facturadoRows = buildFacturadoReconcileRows(rows);
  const currency = reconcileCurrencyFromRows(facturadoRows);
  const parsed =
    currency === "usd"
      ? sumParsedSectionsUsd(facturadoRows)
      : sumParsedSectionsClp(facturadoRows);
  const checks: CcImportReconcileCheck[] = [];
  const monto = header.monto_facturado;
  const compras = header.compras_cargos;

  if (currency === "clp" && monto != null && monto > 0) {
    const billed = parsed.parsed_operaciones + parsed.parsed_cargos_abonos;
    const delta = billed - monto;
    const tol = Math.max(TOL_CLP, Math.abs(monto) * 0.001);
    const ok = closeEnough(billed, monto, tol);
    checks.push({
      code: "monto_facturado",
      ok,
      expected: monto,
      actual: billed,
      delta,
      detail: "operaciones+cargos vs Monto Total Facturado",
    });
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
      const expected = saldo + abono + compras;
      const delta = expected - deuda;
      const ok = closeEnough(expected, deuda, TOL_USD);
      checks.push({
        code: "usd_balance",
        ok,
        expected: deuda,
        actual: expected,
        delta,
        detail: "saldo+abono+compras vs deuda_total",
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
  };
}

function purchaseDateForReconcileRow(row: CcReconcileRow): string {
  return row.transaction_date ?? row.posting_date ?? "";
}

function reconcilePurchaseRowsMatch(a: CcReconcileRow, b: CcReconcileRow): boolean {
  if (a.installment_flag || b.installment_flag) return false;
  if (a.currency !== "clp" || b.currency !== "clp") return false;
  if (a.amount_clp !== b.amount_clp || a.amount_clp <= 0) return false;
  const crossSource = Boolean(a.from_web_paste) !== Boolean(b.from_web_paste);
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

/**
 * Rows that count toward Monto Total Facturado: PDF statement movements plus web-paste
 * lines not already represented on the PDF (same date, amount, merchant stem).
 */
export function buildFacturadoReconcileRows(rows: readonly CcReconcileRow[]): CcReconcileRow[] {
  const pdfRows = rows.filter((r) => !r.from_web_paste);
  const webRows = rows.filter((r) => r.from_web_paste);
  const extraWeb = webRows.filter(
    (w) => !pdfRows.some((p) => reconcilePurchaseRowsMatch(p, w))
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

function dbLineToReconcileRow(
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
  };
}

function isWebPasteSource(sourcePdf: string): boolean {
  return String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

function findPdfAnchorForBillingMonth(
  accountId: number,
  billingMonth: string
): {
  source_pdf: string;
  monto_facturado: number | null;
  compras_cargos: number | null;
} | null {
  let best: {
    source_pdf: string;
    monto_facturado: number | null;
    compras_cargos: number | null;
    score: number;
  } | null = null;

  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    if (isWebPasteSource(st.source_pdf)) continue;
    if (st.currency === "usd") continue;
    const monto = st.monto_facturado;
    const compras = st.compras_cargos;
    if ((monto == null || monto <= 0) && (compras == null || compras <= 0)) continue;
    const score = (monto ?? 0) + (compras ?? 0) * 0.01;
    if (!best || score > best.score) {
      best = {
        source_pdf: st.source_pdf,
        monto_facturado: monto,
        compras_cargos: compras,
        score,
      };
    }
  }
  if (!best) return null;
  return {
    source_pdf: best.source_pdf,
    monto_facturado: best.monto_facturado,
    compras_cargos: best.compras_cargos,
  };
}

function headerAmountFromCsv(first: CcStatementCsvRecord, field: string): number | null {
  const currency = currencyFromRow(first);
  const raw = parseAmountNumber(String(first[field] ?? ""));
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
    abono: headerAmountFromCsv(first, "statement_abono"),
    deuda_total: headerAmountFromCsv(first, "statement_deuda_total"),
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

  const addRow = (row: CcReconcileRow, dedupeKeys: string[]) => {
    const dk = dedupeKeys.find((k) => k.trim()) ?? row.dedupe_key ?? row.row_id;
    if (dk) {
      byDedupe.set(dk, row);
      return;
    }
    const stem = merchantStemForInstallmentDedupe(row.merchant);
    if (stem) {
      const alt = normalizeStemBucketKey(row, stem);
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
      addRow(row, keys);
    }
  }

  for (const rec of incoming) {
    if (billingMonthFromCsvRecord(rec) !== billingMonth) continue;
    if (pdfReconcileOnly && isWebPasteSource(String(rec.source_pdf ?? ""))) continue;
    const row = csvRecordToReconcileRow(rec);
    const keys = canonicalCcLineDedupeKeys(String(rec.card_group ?? "A"), {
      installment_flag: row.installment_flag ? "true" : "false",
      transaction_date: row.transaction_date ?? "",
      posting_date: row.posting_date ?? "",
      merchant: row.merchant ?? "",
      amount_clp: String(row.amount_clp),
      dedupe_key: row.dedupe_key ?? "",
    });
    addRow(row, keys);
  }

  return dedupeCrossSourceReconcileRows([...byDedupe.values(), ...withoutKey]);
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

    let header = findPdfAnchorForBillingMonth(accountId, billingMonth);
    if (!header && pdfIncoming.length > 0) {
      header = headerFromCsvRecords(pdfIncoming);
    }

    if (pdfIncoming.length === 0) {
      continue;
    }

    const headerCurrency =
      pdfIncoming.length > 0 ? currencyFromRow(pdfIncoming[0]!) : "clp";
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

    const rows = buildProjectedReconcileRows(accountId, billingMonth, incoming, replaceKeys, {
      pdfReconcileOnly: true,
    });
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

  return results;
}

export function statementKeysFromIncoming(records: readonly CcStatementCsvRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const row of records) {
    keys.add(statementKeyFromRow(row));
  }
  return keys;
}
