/**
 * Santander statement JSON → ledger write path («JSON leads, PDF import guarded»).
 *
 * Builds the canonical statements of a `card.statement` (the fetched statement JSON, decoded by
 * ingest: `ingest/src/santander/statementJson.ts`) and writes them through
 * the SAME pipeline as PDF statements (`mergeCardStatements`) — reconcile gate,
 * installment ledger, web-paste supersede, traspaso links and valuation re-sync included. A
 * JSON statement is a real statement (it counts toward facturación close and open-bucket
 * supersede exactly like a PDF, via its `source_kind`); the PDF stays the permanent
 * archive and the cross-check when it arrives later.
 *
 * Ownership guard: a (close, currency) already written from a PDF is never rewritten from
 * JSON — those statements get the report-only diff. The symmetric PDF-side guard lives in
 * `mergeCardStatements` (drops PDF records for JSON-owned closes).
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
import { mergeCardStatements, statementKeysOf } from "./ccInstallmentLedgerMerge.js";
import { merchantStemForInstallmentDedupe } from "./ccInstallmentLineDedupe.js";
import { db } from "./db.js";

import { ccJsonStatementLineBaseKey, ccSha1Hex16, dedupeKeysByOccurrence } from "./ccDedupeKey.js";
import {
  cardLineKind,
  cardStatementLayout,
  EMPTY_CARD_STATEMENT_HEADER,
  parseDdMmYyToIso,
  normalizeMerchantText,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";
import { pesosOrDollars } from "./ingestCurrencies.js";
import { lineAmountUsdSql } from "./cards/lineAmountSql.js";

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
  return `json-loan|${ccSha1Hex16(
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
 * One facturación currency → its canonical statement.
 *
 * Line dedupe keys are minted in a `json|` key space (sha16 of group+currency+date+merchant+
 * amount, `#dupN` occurrence for same-statement twins) — deterministic across re-imports so
 * statement replacement stays idempotent and category assignments survive via key restore.
 */
export function buildSantanderStatement(
  currency: "clp" | "usd", // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
  lines: readonly CardStatementLine[],
  totals: Pick<CardStatementCurrency, "billed_total" | "payments_total"> | null,
  ctx: SantanderStatementRecordsCtx
): CardCanonicalStatement {
  const paymentRows = currency === "clp" ? lines.filter((l) => l.kind === "payment") : []; // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
  const nonPaymentRows = lines.filter((l) => !paymentRows.includes(l));
  // Payment-only months (dormant cards) keep the payment row as a negative line — a statement
  // with zero rows would not be written at all, and the owed walk's covered-check prevents
  // double counting against the dated header.
  const keepPaymentRowsAsLines = nonPaymentRows.length === 0 && paymentRows.length > 0;
  const lineRows = keepPaymentRowsAsLines ? lines : nonPaymentRows;

  const totalPagos = totals?.payments_total ?? null;
  if (currency === "clp" && paymentRows.length > 0) { // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
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
  const section = currency === "usd" ? "international_usd" : "compact"; // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)

  // Occurrence-indexed in line order: the Nth identical line of the statement is its `#dupN` twin.
  const lineAmount = (line: CardStatementLine): number =>
    // A cuota line's amount is the purchase's total; its cuota rides apart.
    currency === "clp" ? (line.installment ? line.installment.total_amount : line.amount) : Number(line.amount.toFixed(2)); // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
  const baseKeys = lineRows.map((line) => {
    const amountKey = currency === "usd" ? lineAmount(line).toFixed(2) : String(lineAmount(line)); // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
    return ccJsonStatementLineBaseKey(ctx.cardGroup, currency, line.transaction_date, line.merchant, amountKey);
  });
  const dedupeKeys = dedupeKeysByOccurrence(baseKeys);
  const canonicalLines = lineRows.map((line, lineIndex): CardCanonicalLine => {
    const amount = lineAmount(line);
    const dedupeKey = dedupeKeys[lineIndex]!;
    const merchant = line.merchant.trim();
    const inst = line.installment;
    return {
      kind: cardLineKind({
        installment_flag: inst != null,
        merchant: merchant || null,
        amount_clp: currency === "clp" ? amount : 0, // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
        amount_usd: currency === "usd" ? amount : null, // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
        statement_currency: currency,
      }),
      transaction_date: line.transaction_date,
      posting_date: line.posting_date ?? null,
      printed_transaction_date: null,
      printed_posting_date: null,
      merchant,
      description: null,
      place: line.place?.trim() || null,
      country: line.country?.trim() || null,
      currency,
      amount,
      origin_amount: line.origin_amount != null ? Number(line.origin_amount.toFixed(2)) : null,
      installment: inst
        ? {
            number: inst.number,
            count: inst.count,
            cuota_amount: inst.cuota_amount,
            total_amount: null,
            interest_rate_text: null,
            cuota_type: null,
            plan_id:
              currency === "clp" // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
                ? resolveJsonCuotaCanonicalRowId(ctx.accountId, ctx.cardGroup, line.transaction_date, inst.total_amount, inst.count, line.merchant)
                : null,
          }
        : null,
      origin_card_last4: line.card_last4?.trim() || null,
      cuota_purchase: null,
      document: {
        line_id: `json:${dedupeKey}`,
        dedupe_key: dedupeKey,
        section,
        raw_text: line.raw_text.trim() || null,
        duplicate_across_statements: false,
        baseline_match: null,
      },
    };
  });

  return {
    document: santanderJsonSourcePdf(currency, ctx.statementDate),
    card_group: ctx.cardGroup,
    close: ctx.statementDate,
    period_from: ctx.periodFrom,
    period_to: ctx.statementDate,
    pay_by: ctx.payBy,
    card_last4: ctx.cardLast4?.trim() || null,
    card_product: null,
    currency,
    layout: cardStatementLayout(section),
    header: {
      ...EMPTY_CARD_STATEMENT_HEADER,
      monto_facturado: currency === "clp" && billed != null ? billed : null, // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
      monto_pagado_anterior: currency === "clp" && totalPagos != null && totalPagos > 0 ? -totalPagos : null, // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
      monto_pagado_anterior_date: currency === "clp" ? pagadoDate : null, // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
      // Only the end is published (FechaProxFact); the cycle's first day stays whatever the PDF
      // prints — the close-day offset is read from statements that print both.
      next_period_to: ctx.nextClose ?? null,
    },
    lines: canonicalLines,
  };
}

const listStatementClosesForCurrency = db.prepare(
  `SELECT DISTINCT statement_date, card_group FROM cc_statements
   WHERE account_id = ? AND currency = ?
     AND source_kind NOT IN ('listing_open', 'listing_other')`
);

/**
 * Statement context inherited from the account's own history: the card group the ledger
 * already uses for this currency and the previous close (= the PDF twins' `period_from`).
 * Throws when the account has no prior statements of the currency — a brand-new card's first
 * JSON import needs an explicit decision, not a silent default.
 */
export function inheritedStatementCtx(
  accountId: number,
  currency: "clp" | "usd", // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
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
      `SELECT l.transaction_date, l.merchant, ${lineAmountUsdSql("l")} AS amount_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.currency = 'usd' AND ${lineAmountUsdSql("l")} IS NOT NULL
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
        `${parseDdMmYyToIso(String(l.transaction_date ?? ""))}|${normalizeMerchantText(String(l.merchant ?? ""))}|${Math.abs(l.amount_usd).toFixed(2)}`
    )
  );
  return lines.every((line) =>
    seen.has(
      `${line.transaction_date}|${normalizeMerchantText(line.merchant)}|${Math.abs(line.amount).toFixed(2)}`
    )
  );
}

export type SantanderStatementWriteResult = {
  accountId: number;
  statementDate: string;
  currencies: ("clp" | "usd")[]; // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
  lineCount: number;
};

/** Write one facturación (both currencies together, so a traspaso month links atomically). */
export function writeSantanderStatements(
  accountId: number,
  statements: readonly CardCanonicalStatement[]
): SantanderStatementWriteResult {
  if (statements.length === 0) throw new Error("writeSantanderStatements: no statements");
  // One close per call: the result names a single facturación, and the caller verifies it.
  const closes = new Set(statements.map((st) => padCcStatementDate(st.close)));
  if (closes.size !== 1) {
    throw new Error(
      `writeSantanderStatements: statements span ${closes.size} closes (${[...closes].join(", ")}) — ` +
        `write one facturación per call`
    );
  }
  for (const last4 of new Set(statements.map((st) => st.card_last4 ?? ""))) {
    assertNoCardRoutingConflict(accountId, last4 || null);
  }
  const merged = mergeCardStatements(accountId, statements, {
    replaceLedger: false,
    replaceStatementKeys: statementKeysOf(statements),
  });
  return {
    accountId,
    statementDate: statements[0]!.close,
    currencies: [...new Set(statements.map((st) => pesosOrDollars(st.currency, "card.statement")))],
    lineCount: merged.statements.linesInserted,
  };
}

/** The `next_period_to` of the real (non-web-paste) statement for a close, if any. */
export function statementNextPeriodTo(
  accountId: number,
  statementDate: string,
  currency: "clp" | "usd" // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
): string | null {
  const row = db
    .prepare(
      `SELECT next_period_to FROM cc_statements
       WHERE account_id = ? AND statement_date = ? AND currency = ?
         AND source_kind NOT IN ('listing_open', 'listing_other')
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
  currency: "clp" | "usd", // convention-ok: the Santander statement JSON is national (pesos) or international (dollars)
  nextClose: string
): void {
  db.prepare(
    `UPDATE cc_statements SET next_period_to = ?
     WHERE account_id = ? AND statement_date = ? AND currency = ? AND next_period_to IS NULL
       AND source_kind NOT IN ('listing_open', 'listing_other')`
  ).run(padCcStatementDate(nextClose), accountId, padCcStatementDate(statementDate), currency);
}
