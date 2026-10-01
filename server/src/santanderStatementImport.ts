/**
 * Santander statement JSON → ledger write path («JSON leads, PDF import guarded»).
 *
 * Builds `CcStatementCsvRecord` rows from a `card.statement` (the fetched statement JSON, decoded
 * by ingest: `ingest/src/santander/statementJson.ts`) and writes them through
 * the SAME pipeline as PDF statements (`mergeCcAccountFromParsedRows`) — reconcile gate,
 * installment ledger, web-paste supersede, traspaso links and valuation re-sync included. A
 * JSON statement is a real statement (it counts toward facturación close and open-bucket
 * supersede exactly like a PDF, via `isPdfStatementSource`); the PDF stays the permanent
 * archive and the cross-check when it arrives later.
 *
 * Ownership guard: a (close, currency) already written from a PDF is never rewritten from
 * JSON — those statements get the report-only diff. The symmetric PDF-side guard lives in
 * `mergeCcAccountFromParsedRows` (drops PDF records for JSON-owned closes).
 *
 * Field mapping was validated empirically against the 2026-07-23 facturación (card ·0901,
 * statements 321/322) — see `ingest/src/santander/statementJson.ts` for the per-field traps. Header
 * mapping (national RESPUESTA → statement columns):
 *   - monto_facturado ← DeudaTotalFact (9xx.xxx matched the PDF-imported value exactly; it
 *     also equals TotalCompras + TotalCargosAut + TotalCargos on the same feed)
 *   - monto_pagado_anterior ← −TotalPagos, dated by the payment row (CodTxs 067) (exact date — better
 *     than the PDF parser's single-row-match heuristic); the 067 line itself is dropped like
 *     the PDF parser does, UNLESS dropping it would leave the statement empty (dormant
 *     payment-only months keep it as a negative line, sign flipped from the feed's unsigned
 *     MontoTxs).
 *   - saldo_anterior / abono / compras_cargos / deuda_total stay NULL: the PDF columns carry
 *     per-format semantics this feed does not reproduce (e.g. the WorldMember «saldo
 *     anterior» 4.xxx.xxx vs the feed's SaldoAnterior 2.xxx.xxx = previous facturado).
 *   - The international RESPUESTA is all nulls (verified on an active card), so USD
 *     statements carry line data only; `facturadoFromStatement` falls back to line sums.
 */
import type { CardStatementCurrency, CardStatementLine } from "nw-tracker-contracts";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { padCcStatementDate, santanderJsonSourcePdf } from "./ccStatementJsonSource.js";
import {
  mergeCcAccountFromParsedRows,
  replaceStatementKeysFromRecords,
} from "./ccInstallmentLedgerMerge.js";
import { merchantStemForInstallmentDedupe } from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { ccOriginAmountCsvCell } from "./ccOriginCurrency.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { db } from "./db.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import crypto from "node:crypto";

function sha1Hex16(payload: string): string {
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

function normMerchantForKey(merchant: string): string {
  return String(merchant ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

const findContractCanonical = db.prepare(
  `SELECT canonical_row_id, merchant FROM cc_installment_purchases
   WHERE account_id = ? AND card_group = ? AND purchase_date = ?
     AND cuotas_totales = ? AND total_amount_clp = ?`
);

/**
 * Contract identity for a JSON cuota row. A plan billed from PDFs before the JSON took over
 * must keep accruing payments on the SAME `cc_installment_purchases` row — the ledger merge
 * conflicts on (account_id, card_group, canonical_row_id), so reuse the stored canonical when
 * a contract with identical content exists; only new plans mint a fresh (content-derived,
 * stable across months) id.
 */
export function resolveJsonCuotaCanonicalRowId(
  accountId: number,
  cardGroup: string,
  purchaseDateIso: string,
  totalAmountClp: number,
  cuotasTotal: number,
  merchant: string
): string {
  const stem = merchantStemForInstallmentDedupe(merchant);
  const hits = findContractCanonical.all(
    accountId,
    cardGroup,
    purchaseDateIso,
    cuotasTotal,
    totalAmountClp
  ) as { canonical_row_id: string; merchant: string | null }[];
  for (const hit of hits) {
    if (merchantStemForInstallmentDedupe(hit.merchant) === stem) return hit.canonical_row_id;
  }
  return `json-loan|${sha1Hex16(
    `${cardGroup}|${purchaseDateIso}|${totalAmountClp}|${cuotasTotal}|${stem.toUpperCase()}`
  )}`;
}

export type SantanderStatementRecordsCtx = {
  accountId: number;
  /** Statement close, zero-padded dd/mm/yyyy (the national FechaFactActual; international
   * statements take it from the national twin — that RESPUESTA carries no dates). */
  statementDate: string;
  cardGroup: string;
  /** Previous close of the same currency (the PDF twins' `period_from` convention). */
  periodFrom: string;
  payBy: string | null;
  cardLast4: string | null;
  /** Next close (FechaProxFact), zero-padded dd/mm/yyyy; the international side takes the
   * national twin's. Stored as the statement's `next_period_to` (see `ccBillingCloses.ts`). */
  nextClose?: string | null;
};

/**
 * One facturación currency → importable CSV records.
 *
 * Line dedupe keys are minted in a `json|` key space (sha16 of group+currency+date+merchant+
 * amount, `#dupN` occurrence for same-statement twins) — deterministic across re-imports so
 * statement replacement stays idempotent and category assignments survive via key restore.
 */
export function buildSantanderStatementRecords(
  currency: "clp" | "usd",
  lines: readonly CardStatementLine[],
  totals: Pick<CardStatementCurrency, "billed_total" | "payments_total"> | null,
  ctx: SantanderStatementRecordsCtx
): CcStatementCsvRecord[] {
  const sourcePdf = santanderJsonSourcePdf(currency, ctx.statementDate);

  const paymentRows = currency === "clp" ? lines.filter((l) => l.kind === "payment") : [];
  const nonPaymentRows = lines.filter((l) => !paymentRows.includes(l));
  // Payment-only months (dormant cards) keep the payment row as a negative line — a statement
  // with zero rows would not be written at all, and the owed walk's covered-check prevents
  // double counting against the dated header.
  const keepPaymentRowsAsLines = nonPaymentRows.length === 0 && paymentRows.length > 0;
  const lineRows = keepPaymentRowsAsLines ? lines : nonPaymentRows;

  const totalPagos = totals?.payments_total ?? null;
  if (currency === "clp" && paymentRows.length > 0) {
    const sum = paymentRows.reduce((acc, l) => acc - l.amount, 0);
    if (totalPagos == null || Math.abs(sum - totalPagos) > 1) {
      throw new Error(
        `Santander national statement ${ctx.statementDate}: payment rows sum ${sum} but the stated ` +
          `payments total (TotalPagos) is ${totalPagos ?? "missing"} — refusing to fold them into the header`
      );
    }
  }
  const pagadoDate = paymentRows.length === 1 ? paymentRows[0]!.transaction_date : null;
  const billed = totals?.billed_total ?? null;

  const headerCols: Record<string, string> = {
    statement_saldo_anterior: "",
    statement_abono: "",
    statement_compras_cargos: "",
    statement_deuda_total: "",
    statement_monto_facturado: currency === "clp" && billed != null && billed > 0 ? String(billed) : "",
    statement_monto_pagado_anterior:
      currency === "clp" && totalPagos != null && totalPagos > 0 ? String(-totalPagos) : "",
    statement_monto_pagado_anterior_date: currency === "clp" ? (pagadoDate ?? "") : "",
    // Only the end is published (FechaProxFact); the cycle's first day stays whatever the PDF
    // prints — the close-day offset is read from statements that print both.
    statement_next_period_from: "",
    statement_next_period_to: ctx.nextClose ?? "",
  };

  const occurrence = new Map<string, number>();
  const records: CcStatementCsvRecord[] = [];
  for (const line of lineRows) {
    // The record's amount for a cuota line is the purchase's total, its cuota rides apart.
    const amountClp = currency === "clp" ? (line.installment ? line.installment.total_amount : line.amount) : null;
    const amountUsd = currency === "usd" ? line.amount : null;
    const dateIso = line.transaction_date;
    const amountKey = currency === "usd" ? (amountUsd ?? 0).toFixed(2) : String(amountClp ?? 0);
    const base = `json|${sha1Hex16(
      `${ctx.cardGroup}|${currency}|${dateIso}|${normMerchantForKey(line.merchant)}|${amountKey}`
    )}`;
    const n = occurrence.get(base) ?? 0;
    occurrence.set(base, n + 1);
    const dedupeKey = n === 0 ? base : `${base}#dup${n}`;

    const canonical =
      line.installment && currency === "clp"
        ? resolveJsonCuotaCanonicalRowId(
            ctx.accountId,
            ctx.cardGroup,
            dateIso,
            line.installment.total_amount,
            line.installment.count,
            line.merchant
          )
        : "";

    records.push({
      card_group: ctx.cardGroup,
      source_pdf: sourcePdf,
      statement_date: ctx.statementDate,
      period_from: ctx.periodFrom,
      period_to: ctx.statementDate,
      pay_by: ctx.payBy ?? "",
      card_last4: ctx.cardLast4 ?? "",
      card_product: "",
      parser_layout: currency === "usd" ? "international_usd" : "compact",
      currency,
      installment_flag: line.installment ? "true" : "false",
      transaction_date: isoToCsvDate(line.transaction_date),
      posting_date: line.posting_date ? isoToCsvDate(line.posting_date) : "",
      place: line.place ?? "",
      merchant: line.merchant,
      description_merged: "",
      country: line.country ?? "",
      amount_orig: line.origin_amount != null ? ccOriginAmountCsvCell(line.origin_amount) : "",
      foreign_currency: "",
      amount_clp: amountClp != null ? String(amountClp) : "",
      amount_usd: amountUsd != null ? amountUsd.toFixed(2) : "",
      nro_cuota_current: line.installment ? String(line.installment.number) : "",
      nro_cuota_total: line.installment ? String(line.installment.count) : "",
      valor_cuota_mensual_clp: line.installment ? String(line.installment.cuota_amount) : "",
      valor_cuota_mensual_usd: "",
      interest_rate_text: "",
      tipo_cuota: "",
      authorization_code: line.authorization_code ?? "",
      origin_card_last4: line.card_last4 ?? "",
      dedupe_key: dedupeKey,
      row_id: `json:${dedupeKey}`,
      canonical_row_id: canonical,
      is_duplicate_across_statements: "false",
      raw_line: line.raw_text,
      ...headerCols,
    });
  }
  return records;
}

/** `2026-07-23` → `23/7/2026`, the unpadded form statement CSV records carry for line dates. */
export function isoToCsvDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Expected an ISO date, got "${iso}"`);
  return `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
}

const listStatementClosesForCurrency = db.prepare(
  `SELECT DISTINCT statement_date, card_group FROM cc_statements
   WHERE account_id = ? AND currency = ?
     AND source_pdf NOT LIKE 'import:web-paste%'`
);

/**
 * Statement context inherited from the account's own history: the card group the ledger
 * already uses for this currency and the previous close (= the PDF twins' `period_from`).
 * Throws when the account has no prior statements of the currency — a brand-new card's first
 * JSON import needs an explicit decision, not a silent default.
 */
export function inheritedStatementCtx(
  accountId: number,
  currency: "clp" | "usd",
  statementDate: string
): { cardGroup: string; periodFrom: string } {
  const targetIso = parseDdMmYyToIso(padCcStatementDate(statementDate));
  if (!targetIso) throw new Error(`Unparseable statement date "${statementDate}"`);
  const rows = listStatementClosesForCurrency.all(accountId, currency) as {
    statement_date: string;
    card_group: string;
  }[];
  let prev: { iso: string; date: string; group: string } | null = null;
  let latest: { iso: string; group: string } | null = null;
  for (const r of rows) {
    const iso = parseDdMmYyToIso(r.statement_date);
    if (!iso) continue;
    if (!latest || iso > latest.iso) latest = { iso, group: r.card_group };
    if (iso < targetIso && (!prev || iso > prev.iso)) {
      prev = { iso, date: r.statement_date, group: r.card_group };
    }
  }
  if (!latest) {
    throw new Error(
      `Account ${accountId} has no imported ${currency} statements to inherit card_group / ` +
        `period_from from — import its history first (or extend inheritedStatementCtx for new cards)`
    );
  }
  if (!prev) {
    throw new Error(
      `Account ${accountId} has no ${currency} statement before ${statementDate} — ` +
        `period_from cannot be derived`
    );
  }
  return { cardGroup: latest.group, periodFrom: padCcStatementDate(prev.date) };
}

/**
 * The bank's Cuenta→master mapping and the card registry's plastic→master routing must agree
 * before anything is written. They disagreed for real on 2026-08-05: plastic ·0430 bills
 * under the dormant Cuenta ...0228 (mapped to the ·0161 master) per the bank's own Pan, while
 * cc-cards.json consolidates 0430 → 0901 — so five 2025 «tarjeta 0430» PDFs live on the 0901
 * master and a JSON write to the Cuenta-mapped account duplicated a facturación across two
 * accounts. Until the genealogy is fixed in config, importing either way would take a side.
 */
export function assertNoCardRoutingConflict(
  cuentaAccountId: number,
  cardLast4: string | null
): void {
  if (!cardLast4) return;
  const registryAccountId = resolveMasterAccountIdForImportCardLast4(cardLast4);
  if (registryAccountId != null && registryAccountId !== cuentaAccountId) {
    throw new Error(
      `Card routing conflict for plastic ·${cardLast4}: the bank's Cuenta maps to account ` +
        `${cuentaAccountId} but the card registry (cc-cards.json) routes its PDFs to account ` +
        `${registryAccountId}. Fix the genealogy (consolidation redirect / organize-identifiers) ` +
        `before importing this statement from JSON.`
    );
  }
}

/**
 * The international endpoint's RESPUESTA has no dates, so a dormant account's response can
 * carry the LAST BILLED USD cycle's rows rather than the national close's — observed on
 * Cuenta ...0228, whose 24/11/2025 fetch re-served the 25/08/2025 facturación's ABONO. Rows
 * are a stale echo when every one of them (same transaction date + merchant + |USD|) already
 * exists on an earlier statement of the account; recurring subscriptions re-bill on new
 * dates, so date-exact matching keeps genuine repeat charges importable.
 */
export function usdStatementIsStaleEcho(
  accountId: number,
  statementDate: string,
  lines: readonly CardStatementLine[]
): boolean {
  if (lines.length === 0) return false;
  // The target close's own lines are excluded so a JSON-owned rewrite never reads as an echo.
  const existing = db
    .prepare(
      `SELECT l.transaction_date, l.merchant, l.amount_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.currency = 'usd' AND l.amount_usd IS NOT NULL
         AND s.statement_date != ?`
    )
    .all(accountId, padCcStatementDate(statementDate)) as {
    transaction_date: string | null;
    merchant: string | null;
    amount_usd: number;
  }[];
  const seen = new Set(
    existing.map(
      (l) =>
        `${parseDdMmYyToIso(String(l.transaction_date ?? ""))}|${normMerchantForKey(String(l.merchant ?? ""))}|${Math.abs(l.amount_usd).toFixed(2)}`
    )
  );
  return lines.every((line) =>
    seen.has(
      `${line.transaction_date}|${normMerchantForKey(line.merchant)}|${Math.abs(line.amount).toFixed(2)}`
    )
  );
}

export type SantanderStatementWriteResult = {
  accountId: number;
  statementDate: string;
  currencies: ("clp" | "usd")[];
  lineCount: number;
};

/** Write one facturación (both currencies together, so a traspaso month links atomically). */
export function writeSantanderStatements(
  accountId: number,
  records: CcStatementCsvRecord[]
): SantanderStatementWriteResult {
  if (records.length === 0) throw new Error("writeSantanderStatements: no records");
  // One close per call: the result names a single facturación, and the caller verifies it.
  const closes = new Set(records.map((r) => padCcStatementDate(String(r.statement_date ?? ""))));
  if (closes.size !== 1) {
    throw new Error(
      `writeSantanderStatements: records span ${closes.size} closes (${[...closes].join(", ")}) — ` +
        `write one facturación per call`
    );
  }
  for (const last4 of new Set(records.map((r) => String(r.card_last4 ?? "").trim()))) {
    assertNoCardRoutingConflict(accountId, last4 || null);
  }
  const merged = mergeCcAccountFromParsedRows(accountId, records, {
    replaceLedger: false,
    replaceStatementKeys: replaceStatementKeysFromRecords(records),
  });
  return {
    accountId,
    statementDate: String(records[0]!.statement_date ?? ""),
    currencies: [...new Set(records.map((r) => (r.currency === "usd" ? "usd" : "clp")))] as (
      | "clp"
      | "usd"
    )[],
    lineCount: merged.statements.linesInserted,
  };
}

/** The `next_period_to` of the real (non-web-paste) statement for a close, if any. */
export function statementNextPeriodTo(
  accountId: number,
  statementDate: string,
  currency: "clp" | "usd"
): string | null {
  const row = db
    .prepare(
      `SELECT next_period_to FROM cc_statements
       WHERE account_id = ? AND statement_date = ? AND currency = ?
         AND source_pdf NOT LIKE 'import:web-paste%'
       ORDER BY id DESC LIMIT 1`
    )
    .get(accountId, padCcStatementDate(statementDate), currency) as
    | { next_period_to: string | null }
    | undefined;
  return row?.next_period_to ?? null;
}

/**
 * Fill a PDF-owned statement's missing `next_period_to` from the JSON's FechaProxFact — a header
 * field only (no lines, no reconcile), for statements whose format predates the printed line.
 */
export function fillStatementNextPeriodTo(
  accountId: number,
  statementDate: string,
  currency: "clp" | "usd",
  nextClose: string
): void {
  db.prepare(
    `UPDATE cc_statements SET next_period_to = ?
     WHERE account_id = ? AND statement_date = ? AND currency = ? AND next_period_to IS NULL
       AND source_pdf NOT LIKE 'import:web-paste%'`
  ).run(padCcStatementDate(nextClose), accountId, padCcStatementDate(statementDate), currency);
  invalidateCcBillingDetail(accountId);
}
