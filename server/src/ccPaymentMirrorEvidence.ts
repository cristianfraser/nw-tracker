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
 * Leaf module (db + two pure helpers), so any card reader or writer can import it without a cycle.
 */
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { isCcPaymentMerchant, requireHeaderPagoIso } from "./ccPaymentLines.js";
import { db } from "./db.js";

export type CcPaymentEvidenceCurrency = "clp" | "usd";

/** The fields that identify a card payment, on the evidence side and on the pairing side alike. */
export type CcPaymentIdentity = {
  cc_account_id: number;
  pago_iso: string;
  currency: CcPaymentEvidenceCurrency;
  /**
   * Positive pesos of a peso payment. A dollar payment's key ignores it: 0 on an evidence row (an
   * ABONO DE DIVISAS carries no pesos), the pesos the divisas purchase paid on a pairing.
   */
  amount_clp: number;
  /** Positive dollars of a dollar payment; null for a peso payment. */
  amount_usd: number | null;
};

/** The payment identity as a map key: pesos to the unit, dollars to the cent. */
export function ccPaymentEvidenceKey(p: CcPaymentIdentity): string {
  if (p.currency === "usd") {
    if (p.amount_usd == null) {
      throw new Error(`card payment ${p.cc_account_id} ${p.pago_iso}: a dollar payment needs its dollars`);
    }
    return `${p.cc_account_id}|${p.pago_iso}|usd|${Math.round(p.amount_usd * 100)}`;
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

const stmtClpPaymentLines = db.prepare(
  `SELECT l.id AS line_id, s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name,
          l.transaction_date, l.amount_clp, l.merchant
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   JOIN accounts a ON a.id = s.account_id
   WHERE s.currency = 'clp' AND l.installment_flag = 0 AND l.amount_clp < 0
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

const stmtHeaderPayments = db.prepare(
  `SELECT s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name, s.statement_date,
          s.monto_pagado_anterior AS amt, s.monto_pagado_anterior_date AS pago_iso
   FROM cc_statements s
   JOIN accounts a ON a.id = s.account_id
   WHERE s.currency = 'clp'
     AND s.monto_pagado_anterior IS NOT NULL AND s.monto_pagado_anterior_date IS NOT NULL
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

// Matched by the LINE's currency (amount_usd set), not the statement's — the open web-paste bucket
// is a CLP statement that carries the USD lines too, and an abono must be pairable the day the feed
// delivers it. Traspaso-linked abonos are not payments: they reclassify USD debt onto the CLP side
// of the same card, no cash moved.
const stmtUsdAbonoLines = db.prepare(
  `SELECT l.id AS line_id, s.id AS statement_id, s.source_pdf, s.account_id, a.name AS account_name,
          l.transaction_date, l.amount_usd, l.merchant
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   JOIN accounts a ON a.id = s.account_id
   WHERE l.installment_flag = 0 AND l.amount_usd < 0
     AND UPPER(l.merchant) LIKE '%ABONO DE DIVISAS%'
     AND l.id NOT IN (SELECT usd_line_id FROM cc_traspaso_deuda_links)
     AND (@account_id IS NULL OR s.account_id = @account_id)`
);

/**
 * Every row carrying a card payment, on one card or all of them: CLP payment lines and header
 * payments — the same `isCcPaymentMerchant` test and date readers as the cuota retirement's
 * `listClpCcPaymentEventsForAccount` — then the USD side's ABONO DE DIVISAS lines. Lines come before
 * headers, so a reader keeping the first row per key prefers the line.
 */
export function listCcPaymentEvidenceRows(accountId?: number): CcPaymentEvidenceRow[] {
  const params = { account_id: accountId ?? null };
  const out: CcPaymentEvidenceRow[] = [];
  const push = (row: Omit<CcPaymentEvidenceRow, "key">) => out.push({ ...row, key: ccPaymentEvidenceKey(row) });
  for (const r of stmtClpPaymentLines.all(params) as {
    line_id: number;
    statement_id: number;
    source_pdf: string;
    account_id: number;
    account_name: string;
    transaction_date: string | null;
    amount_clp: number;
    merchant: string | null;
  }[]) {
    if (!isCcPaymentMerchant(r.merchant)) continue;
    const iso = normalizeTransactionDateIso(r.transaction_date);
    if (!iso) continue;
    const amount = Math.round(Math.abs(r.amount_clp));
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
      amount_usd: null,
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
      amount_usd: null,
      label: "MONTO CANCELADO",
    });
  }
  for (const r of stmtUsdAbonoLines.all(params) as {
    line_id: number;
    statement_id: number;
    source_pdf: string;
    account_id: number;
    account_name: string;
    transaction_date: string | null;
    amount_usd: number;
    merchant: string | null;
  }[]) {
    const iso = normalizeTransactionDateIso(r.transaction_date);
    if (!iso) continue;
    const usd = Math.abs(r.amount_usd);
    if (usd === 0) continue;
    push({
      kind: "line",
      id: r.line_id,
      statement_id: r.statement_id,
      source_pdf: r.source_pdf,
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      pago_iso: iso,
      currency: "usd",
      amount_clp: 0,
      amount_usd: usd,
      label: `${(r.merchant ?? "ABONO DE DIVISAS").trim()} US$${usd.toFixed(2)}`,
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
    const usd = r.counter_currency === "usd";
    if (
      r.flow_kind !== "pago_tarjeta" ||
      r.account_id != null ||
      r.to_account_id == null ||
      r.currency !== "clp" ||
      !(r.amount > 0) ||
      (r.counter_currency != null && !usd) ||
      (usd && !(r.counter_amount != null && r.counter_amount > 0))
    ) {
      throw new Error(
        `movement_mirror_merges ${r.transfer_movement_id}: card evidence on a transfer that is not a ` +
          `pago_tarjeta payment into a card in pesos (with dollars for a divisas payment)`
      );
    }
    const identity: CcPaymentIdentity = {
      cc_account_id: r.to_account_id,
      pago_iso: r.occurred_on,
      currency: usd ? "usd" : "clp",
      amount_clp: Math.round(r.amount),
      amount_usd: usd ? r.counter_amount : null,
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
  const amount = p.currency === "usd" ? `US$${p.amount_usd!.toFixed(2)}` : `$${p.amount_clp}`;
  return `transfer ${p.transfer_movement_id} (card ${p.cc_account_id}, ${p.pago_iso}, ${amount})`;
}

/** Pairings (of one card, or all) whose payment no current evidence row carries. */
export function ccPaymentPairingsWithoutEvidence(accountId?: number): CcPaymentPairing[] {
  const keys = new Set(listCcPaymentEvidenceRows(accountId).map((r) => r.key));
  return listCcPaymentPairings(accountId).filter((p) => !keys.has(p.key));
}
