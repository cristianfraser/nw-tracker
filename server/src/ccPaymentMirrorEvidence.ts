/**
 * The card evidence behind a converted checking↔card payment (`ccPaymentMirrors.ts`), found by the
 * payment itself: its card, currency, date and amount — the identity the pairing module already used
 * to fold duplicate statement versions, and a legacy statement's line + header, into one payment.
 *
 * A pairing never reaches its evidence by row id. Statement re-imports replace a statement's lines
 * (new ids — `cc_statement_lines.id` has no AUTOINCREMENT, so a deleted top id can even come back as
 * another line), a PDF takes over a JSON-written close (new statement id), and the open web-paste
 * bucket's lines are settled into the statement that bills them, where a pasted PAGO line can come
 * back as the statement's header payment. The payment is the same through all of it.
 * `movement_mirror_merges.in_statement_line_id` / `in_statement_id` keep the row the conversion saw
 * and nothing reads them: they go stale with the first re-import of their statement.
 *
 * The pairing's half of the key is its transfer's card leg, which the conversion builds from the
 * evidence: `to_account_id` is the card, `occurred_on` the card's credit date, and the card-side
 * amount is the USD counter leg of a divisas payment (the ABONO DE DIVISAS dollars) or the pesos of
 * a peso payment.
 *
 * Reads the payment lines through the purchases module (view 5) and the statement headers itself.
 */
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { requireHeaderPagoIso } from "./ccPaymentLines.js";
import { clpPaymentLines, foreignDebtAbonoLines } from "./cards/purchases.js";
import { db } from "./db.js";
import { currencyMinorDigits, isHomeCurrency } from "./displayUnits.js";

/** `clp` for a peso payment; any other code for a payment of the card's debt in that currency. */
export type CcPaymentEvidenceCurrency = string;

/** `US$12.50`, `EUR 40.50`: a foreign payment's amount as the evidence labels print it. */
export function foreignPaymentAmountLabel(amount: number, currency: string): string {
  const digits = amount.toFixed(currencyMinorDigits(currency));
  return currency === "usd" ? `US$${digits}` : `${currency.toUpperCase()} ${digits}`; // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3
}

/** The fields that identify a card payment, on the evidence side and on the pairing side alike. */
export type CcPaymentIdentity = {
  cc_account_id: number;
  pago_iso: string;
  currency: CcPaymentEvidenceCurrency;
  /**
   * Positive pesos of a peso payment. A foreign payment's key ignores it: 0 on an evidence row (an
   * ABONO DE DIVISAS carries no pesos), the pesos the divisas purchase paid on a pairing.
   */
  amount_clp: number;
  /** Positive amount of a foreign payment, in `currency`; null for a peso payment. */
  amount_foreign: number | null;
};

/** The payment identity as a map key: pesos to the unit, a foreign currency to its smallest coin. */
export function ccPaymentEvidenceKey(p: CcPaymentIdentity): string {
  if (!isHomeCurrency(p.currency)) {
    if (p.amount_foreign == null) {
      throw new Error(`card payment ${p.cc_account_id} ${p.pago_iso}: a ${p.currency.toUpperCase()} payment needs its amount`);
    }
    const scale = 10 ** currencyMinorDigits(p.currency);
    return `${p.cc_account_id}|${p.pago_iso}|${p.currency}|${Math.round(p.amount_foreign * scale)}`;
  }
  return `${p.cc_account_id}|${p.pago_iso}|clp|${Math.round(p.amount_clp)}`;
}

/**
 * One row that carries a card payment. Every version is listed: two statements printing the same
 * payment, or a legacy statement printing it as a line and in its header, give two rows with one key.
 */
export type CcPaymentEvidenceRow = CcPaymentIdentity & {
  /** `line`: a payment line (`id` = cc_statement_lines.id); `header`: a statement's monto_pagado_anterior (`id` = cc_statements.id). */
  kind: "line" | "header";
  id: number;
  statement_id: number;
  source_pdf: string;
  cc_account_name: string;
  label: string;
  key: string;
};

const stmtHeaderPayments = db.prepare(
  `SELECT s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name, s.statement_date,
          s.monto_pagado_anterior AS amt, s.monto_pagado_anterior_date AS pago_iso
   FROM cc_statements s
   JOIN accounts a ON a.id = s.account_id
   WHERE s.currency = 'clp'
     AND s.monto_pagado_anterior IS NOT NULL AND s.monto_pagado_anterior_date IS NOT NULL
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

// The dated legs of a header payment the statement printed without a date (migration 213), each on
// the statement row of its close in its currency (the lowest id when the statement has several
// copies; dollar legs since migration 218). A leg whose close has no statement any more is bad stored state: listed with a null statement, and
// `listCcPaymentEvidenceRows` throws on it.
const stmtHeaderLegs = db.prepare(
  `SELECT g.id AS leg_id, g.account_id, a.name AS account_name, g.statement_close_iso, g.currency, g.paid_on, g.amount,
          (SELECT MIN(s.id) FROM cc_statements s
            WHERE s.account_id = g.account_id AND s.currency = g.currency
              AND s.statement_date = substr(g.statement_close_iso, 9, 2) || '/' || substr(g.statement_close_iso, 6, 2) || '/' || substr(g.statement_close_iso, 1, 4)
              AND s.source_kind NOT IN ('listing_open', 'listing_other')) AS statement_id
   FROM cc_header_payment_legs g
   JOIN accounts a ON a.id = g.account_id
   WHERE (@account_id IS NULL OR g.account_id = @account_id)`
);

/**
 * Every row carrying a card payment, on one card or all of them: CLP payment lines, dated header
 * payments and the dated legs of undated ones (`cc_header_payment_legs`) — the same `isCcPaymentMerchant` test and date readers as the cuota retirement's
 * `listClpCcPaymentEventsForAccount` — then the USD side's ABONO DE DIVISAS lines. Lines come before
 * headers, so a reader keeping the first row per key prefers the line.
 */
export function listCcPaymentEvidenceRows(accountId?: number): CcPaymentEvidenceRow[] {
  const params = { account_id: accountId ?? null };
  const out: CcPaymentEvidenceRow[] = [];
  const push = (row: Omit<CcPaymentEvidenceRow, "key">) => out.push({ ...row, key: ccPaymentEvidenceKey(row) });
  for (const r of clpPaymentLines(accountId)) {
    const iso = normalizeTransactionDateIso(r.transaction_date);
    if (!iso) continue;
    const amount = Math.round(Math.abs(r.amount));
    if (amount === 0) continue;
    push({
      kind: "line",
      id: r.line_id,
      statement_id: r.statement_id,
      source_pdf: r.source_pdf,
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      pago_iso: iso,
      currency: "clp",
      amount_clp: amount,
      amount_foreign: null,
      label: (r.merchant ?? "PAGO").trim(),
    });
  }
  for (const r of stmtHeaderPayments.all(params) as {
    statement_id: number;
    source_pdf: string;
    account_id: number;
    account_name: string;
    statement_date: string;
    amt: number;
    pago_iso: string;
  }[]) {
    const amount = Math.round(Math.abs(r.amt));
    if (amount === 0) continue;
    push({
      kind: "header",
      id: r.statement_id,
      statement_id: r.statement_id,
      source_pdf: r.source_pdf,
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      pago_iso: requireHeaderPagoIso(r.statement_date, r.pago_iso),
      currency: "clp",
      amount_clp: amount,
      amount_foreign: null,
      label: "MONTO CANCELADO",
    });
  }
  for (const r of stmtHeaderLegs.all(params) as {
    leg_id: number;
    account_id: number;
    account_name: string;
    statement_close_iso: string;
    currency: string;
    paid_on: string;
    amount: number;
    statement_id: number | null;
  }[]) {
    if (r.statement_id == null) {
      throw new Error(
        `header payment leg ${r.leg_id} (card ${r.account_id}, ${r.paid_on} ${r.amount} ${r.currency}): no ${r.currency.toUpperCase()} statement closes on ${r.statement_close_iso}`
      );
    }
    push({
      kind: "header",
      id: r.statement_id,
      statement_id: r.statement_id,
      source_pdf: "",
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      pago_iso: r.paid_on,
      currency: r.currency,
      amount_clp: isHomeCurrency(r.currency) ? r.amount : 0,
      amount_foreign: !isHomeCurrency(r.currency) ? r.amount : null,
      label:
        !isHomeCurrency(r.currency)
          ? `ABONO DE DIVISAS ${foreignPaymentAmountLabel(r.amount, r.currency)} (header leg)`
          : "MONTO CANCELADO (header leg)",
    });
  }
  for (const r of foreignDebtAbonoLines(accountId)) {
    const iso = normalizeTransactionDateIso(r.transaction_date);
    if (!iso) continue;
    const foreign = Math.abs(r.amount);
    if (foreign === 0) continue;
    push({
      kind: "line",
      id: r.line_id,
      statement_id: r.statement_id,
      source_pdf: r.source_pdf,
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      pago_iso: iso,
      currency: r.currency,
      amount_clp: 0,
      amount_foreign: foreign,
      label: `${(r.merchant ?? "ABONO DE DIVISAS").trim()} ${foreignPaymentAmountLabel(foreign, r.currency)}`,
    });
  }
  return out;
}

/** A converted checking↔card payment (a `movement_mirror_merges` row whose in side is card evidence). */
export type CcPaymentPairing = CcPaymentIdentity & {
  transfer_movement_id: number;
  key: string;
  /** The evidence row the conversion saw — provenance only (see the module doc). */
  recorded_statement_line_id: number | null;
  recorded_statement_id: number | null;
};

const stmtPairings = db.prepare(
  `SELECT mm.transfer_movement_id, mm.in_statement_line_id, mm.in_statement_id,
          m.to_account_id, m.account_id, m.occurred_on, m.amount, m.currency,
          m.counter_amount, m.counter_currency, m.flow_kind
   FROM movement_mirror_merges mm
   JOIN movements m ON m.id = mm.transfer_movement_id
   WHERE mm.in_movement_id IS NULL
     AND (@account_id IS NULL OR m.to_account_id = @account_id)
   ORDER BY mm.transfer_movement_id`
);

/**
 * The converted card payments, on one card or all, each with the key of the payment it mirrors
 * (its transfer's card leg). Throws on a pairing whose transfer is not the conversion's shape, and
 * when two transfers mirror one payment — both are bad stored state.
 */
export function listCcPaymentPairings(accountId?: number): CcPaymentPairing[] {
  const out: CcPaymentPairing[] = [];
  const byKey = new Map<string, number>();
  for (const r of stmtPairings.all({ account_id: accountId ?? null }) as {
    transfer_movement_id: number;
    in_statement_line_id: number | null;
    in_statement_id: number | null;
    to_account_id: number | null;
    account_id: number | null;
    occurred_on: string;
    amount: number;
    currency: string;
    counter_amount: number | null;
    counter_currency: string | null;
    flow_kind: string | null;
  }[]) {
    const foreign = r.counter_currency != null;
    if (
      r.flow_kind !== "pago_tarjeta" ||
      r.account_id != null ||
      r.to_account_id == null ||
      !isHomeCurrency(r.currency) ||
      !(r.amount > 0) ||
      (r.counter_currency != null && isHomeCurrency(r.counter_currency)) ||
      (foreign && !(r.counter_amount != null && r.counter_amount > 0))
    ) {
      throw new Error(
        `movement_mirror_merges ${r.transfer_movement_id}: card evidence on a transfer that is not a ` +
          `pago_tarjeta payment into a card in pesos (with the foreign amount for a divisas payment)`
      );
    }
    const identity: CcPaymentIdentity = {
      cc_account_id: r.to_account_id,
      pago_iso: r.occurred_on,
      currency: foreign ? r.counter_currency! : "clp",
      amount_clp: Math.round(r.amount),
      amount_foreign: foreign ? r.counter_amount : null,
    };
    const key = ccPaymentEvidenceKey(identity);
    const other = byKey.get(key);
    if (other != null) {
      throw new Error(
        `transfers ${other} and ${r.transfer_movement_id} both mirror the card payment ${key} — one payment converts once`
      );
    }
    byKey.set(key, r.transfer_movement_id);
    out.push({
      ...identity,
      transfer_movement_id: r.transfer_movement_id,
      key,
      recorded_statement_line_id: r.in_statement_line_id,
      recorded_statement_id: r.in_statement_id,
    });
  }
  return out;
}

/** `transfer 123 (card 45, 2026-01-02, US$10.00)` — for error messages and reports. */
export function describeCcPaymentPairing(p: CcPaymentPairing): string {
  const amount = !isHomeCurrency(p.currency) ? foreignPaymentAmountLabel(p.amount_foreign!, p.currency) : `$${p.amount_clp}`;
  return `transfer ${p.transfer_movement_id} (card ${p.cc_account_id}, ${p.pago_iso}, ${amount})`;
}

/** Pairings (of one card, or all) whose payment no current evidence row carries. */
export function ccPaymentPairingsWithoutEvidence(accountId?: number): CcPaymentPairing[] {
  const keys = new Set(listCcPaymentEvidenceRows(accountId).map((r) => r.key));
  return listCcPaymentPairings(accountId).filter((p) => !keys.has(p.key));
}

/** Transfer ids of the card's pairings whose payment some evidence row carries — the state a write must keep. */
export function ccPaymentPairingIdsWithEvidence(accountId: number): Set<number> {
  const keys = new Set(listCcPaymentEvidenceRows(accountId).map((r) => r.key));
  return new Set(
    listCcPaymentPairings(accountId)
      .filter((p) => keys.has(p.key))
      .map((p) => p.transfer_movement_id)
  );
}

/**
 * Throws, naming them, when a write left pairings of the card without the evidence they had before
 * it (`before` = {@link ccPaymentPairingIdsWithEvidence} read ahead of the write): the write removed
 * the payment the pairing mirrors — a re-parse that moved or dropped it, a deleted line — which
 * would leave the transfer booked against nothing and let the payment be paired a second time if it
 * came back under another date. Call it inside the write's transaction so the throw rolls the write
 * back. A pairing that had no evidence before is not this write's doing:
 * `listCcPaymentMirrorCandidates` refuses to pair anything while one exists.
 */
export function assertCcPaymentEvidenceKept(accountId: number, before: ReadonlySet<number>, what: string): void {
  if (before.size === 0) return;
  const lost = ccPaymentPairingsWithoutEvidence(accountId).filter((p) => before.has(p.transfer_movement_id));
  if (lost.length === 0) return;
  throw new Error(
    `Account ${accountId}: ${what} removes the card evidence of ${lost.length} converted card payment(s): ` +
      `${lost.map(describeCcPaymentPairing).join("; ")}. A pairing mirrors its payment by card, date and amount, ` +
      `so the statement must keep printing it (as a payment line or the header's monto pagado); ` +
      `if the payment really moved, undo the pairing (undoMirrorConversion) and convert it again.`
  );
}

/** {@link assertCcPaymentEvidenceKept} around one write; run it inside the write's transaction. */
export function keepingCcPaymentEvidence<T>(accountId: number, what: string, write: () => T): T {
  const before = ccPaymentPairingIdsWithEvidence(accountId);
  const result = write();
  assertCcPaymentEvidenceKept(accountId, before, what);
  return result;
}
