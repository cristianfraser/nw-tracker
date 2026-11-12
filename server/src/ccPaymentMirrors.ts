/**
 * Checking↔credit-card payment mirrors: converts a checking "Traspaso a T. Crédito"/PAGO
 * TARJETA debit plus the card's payment evidence into one transfer row, collapsing the
 * bank's posting-date skew (card credits the payment one to three days before the cartola
 * debits checking, which bumped the CC-netted cash bucket for the gap).
 *
 * The "in" side is statement evidence, never a movement: a payment line (legacy formats;
 * `isCcPaymentMerchant` — PAGO, MONTO CANCELADO, ABONO) or the statement's
 * `monto_pagado_anterior` header (current format, migration 166). The evidence stays
 * untouched — the CC daily owed walk keeps reading it — and the transfer's card leg is inert
 * for CC valuation (CC balances never read movements).
 * The transfer takes the CARD's credit date (the immovable evidence side; the checking
 * cartola date is preserved as `out_occurred_on` in `movement_mirror_merges`, mirroring the
 * month-precision exception in movementMirrorConvert.ts).
 *
 * flow_kind `pago_tarjeta`: the transfer is internal to the CC-netted cash bucket (paying
 * your own card moves no wealth), so deposit/aportes readers skip it (accountDeposits.ts).
 *
 * USD-debt payments (2026-08-07): a checking «Egreso por Compra de Divisas» debit pairs with
 * the card's ABONO DE DIVISAS line on the USD statement. Cross-currency, so the match is date
 * window + one-to-one uniqueness + an implied-fx sanity band instead of amount equality, and
 * the converted transfer is the migration-169 cross-currency shape: CLP from-leg = the exact
 * pesos that left checking, USD counter leg = the card's abono. Traspaso-linked abonos are
 * excluded (debt reclassification, no cash).
 *
 * A converted pair stays tied to its evidence by the payment's card, date and amount, never by the
 * statement row it was paired with — re-imports replace those rows (`ccPaymentMirrorEvidence.ts`).
 */
import { dayWithinWindow, daysBetweenIso } from "nw-tracker-contracts";
import { recordBankPosting } from "./movementBankPostings.js";


import { accountIdsUnderCheckingAccounts } from "./movementBalanceCashAccounts.js";
import { CC_PAYMENT_DESC_RE } from "./ccPaymentLines.js";
import {
  ccPaymentEvidenceKey,
  describeCcPaymentPairing,
  listCcPaymentEvidenceRows,
  listCcPaymentPairings,
} from "./ccPaymentMirrorEvidence.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL, movementClpLegOrZero, type MovementAmountFields } from "./movementAmounts.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { rankByDistance } from "./matching/pairing.js";
import { convertCurrency } from "./rates.js";
import { foreignPaymentAmountLabel } from "./ccPaymentMirrorEvidence.js";

/**
 * Checking legs of USD-debt payments («Egreso por Compra de Divisas»). Cross-currency, so the
 * pairing to the card's ABONO DE DIVISAS cannot be amount-exact: it is date-window + one-to-one
 * uniqueness, plus an implied-fx sanity band so a coincidental unrelated fx purchase cannot pair
 * with a card abono of a very different size.
 */
const DIVISAS_DESC_RE = /COMPRA\s+DE\s+DIVISAS/i;
const LINEA_CREDITO_PAYMENT_DESC_RE = /TRASPASO(?:\s+\w+)*\s+A\s+L[IÍ]NEA\s+CR[EÉ]DITO/i;
/**
 * A transfer to Khipu (a payment gateway: «Transf a khipu CLBS E»): the BCI card has been paid
 * through it from the cuenta corriente (2025-08-29, 2025-08-31). Khipu also takes other payments,
 * so such a debit is a card payment only when it pairs — exact pesos, the card's PAGO inside the
 * window, one-to-one — like every other wording; an unpaired one stays a plain debit.
 */
const KHIPU_TRANSFER_DESC_RE = /\bTRANSF\w*\.?\s+A\s+KHIPU\b/i;
/**
 * The implied rate (pesos of the checking debit ÷ the card's abono) a divisas pair may show, as a
 * multiple of the currency's own rate on the abono's day: the bank's spread and a few days of
 * movement sit well inside it, a coincidental purchase of a very different size does not.
 */
const DIVISAS_IMPLIED_RATE_BAND = [0.5, 2] as const;

/** The pesos one unit of `currency` was worth on `day` (mid), for the divisas band; null with no rate on file. */
function dayRateClp(currency: string, day: string): number | null {
  const r = convertCurrency(1, currency, "clp", day, { side: "mid", storedOnly: true });
  return r != null && r > 0 ? r : null;
}

export type CcPaymentEvidence = {
  cc_account_id: number;
  cc_account_name: string;
  /** Exactly one of these is set (statement line vs header payment). */
  statement_line_id: number | null;
  statement_id: number | null;
  pago_iso: string;
  /**
   * Positive CLP amount of the payment. Zero for USD evidence — an ABONO DE DIVISAS carries no
   * peso amount; the transfer's pesos come from the checking «Egreso por Compra de Divisas» leg.
   */
  amount_clp: number;
  /** A foreign code = ABONO DE DIVISAS in that currency (the divisas payment's card leg). */
  currency: string;
  /** Positive amount of foreign evidence, in `currency`; null for clp. */
  amount_foreign: number | null;
  label: string;
};

export type CcPaymentMirrorCandidate = {
  out: {
    movement_id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    amount_clp: number;
    note: string | null;
  };
  evidence: CcPaymentEvidence;
  skew_days: number;
  blocked: boolean;
  blocked_reason: string | null;
};

export type CcPaymentMirrorRef = {
  out_movement_id: number;
  statement_line_id?: number | null;
  statement_id?: number | null;
};

/**
 * Payment evidence across every CC master (`listCcPaymentEvidenceRows`), one entry per real-world
 * payment: duplicate statement versions carry the same line, and legacy statements describe the
 * same payment as BOTH a line and a header — the first row per payment key wins, lines before
 * headers (the walk consumes them directly).
 */
function dedupeCcPaymentEvidence(rows: ReturnType<typeof listCcPaymentEvidenceRows>): CcPaymentEvidence[] {
  const byKey = new Map<string, CcPaymentEvidence>();
  for (const r of rows) {
    if (byKey.has(r.key)) continue;
    byKey.set(r.key, {
      cc_account_id: r.cc_account_id,
      cc_account_name: r.cc_account_name,
      statement_line_id: r.kind === "line" ? r.id : null,
      statement_id: r.kind === "header" ? r.id : null,
      pago_iso: r.pago_iso,
      amount_clp: r.amount_clp,
      currency: r.currency,
      amount_foreign: r.amount_foreign,
      label: r.label,
    });
  }
  return [...byKey.values()];
}

/**
 * Candidates: single-leg debits on any account under Checking accounts whose note matches the
 * card-payment description, paired to payment evidence by exact amount within ±4 days (nearest
 * date wins; ambiguity blocks both sides — fail closed, never guess). Already-converted payments
 * are excluded by the payment's key, so a re-imported statement's new rows are not offered again. Throws while a
 * converted payment has lost its evidence: if the payment came back under another date it would
 * look unconverted, and pairing it again would book it twice.
 */
/**
 * Card evidence a hand-entered card payment (`cc_manual_payments`) accounts for: same card,
 * currency and amount, dated from its payment day to the planted-line window's end
 * (`ccPlantedPayments.ts`).
 */
function manualPaymentEvidenceClaim(): (e: CcPaymentEvidence) => boolean {
  const rows = db
    .prepare(`SELECT card_account_id, currency, amount, paid_on FROM cc_manual_payments`)
    .all() as { card_account_id: number; currency: string; amount: number; paid_on: string }[];
  if (rows.length === 0) return () => false;
  return (e) =>
    rows.some((r) => {
      if (r.card_account_id !== e.cc_account_id || r.currency !== e.currency) return false;
      const amount = e.currency !== "clp" ? e.amount_foreign : e.amount_clp;
      if (amount == null) return false;
      const scale = e.currency !== "clp" ? 100 : 1;
      const same = Math.round(amount * scale) === Math.round(r.amount * scale);
      if (!same) return false;
      return dayWithinWindow(r.paid_on, e.pago_iso, MATCH_WINDOWS.planted_payment);
    });
}

/**
 * Card evidence a card-to-card facturado payment (`card_to_card_payments`, `cardToCardPayments.ts`)
 * accounts for: a peso payment on the paid card dated inside the financing-payment window of the
 * transfers, for the pesos of one part, of a day's parts of one record (the matcher's combinations
 * are one day's purchases, and the PAGO it plants is their sum) or of the whole record. Such a PAGO
 * was paid by the other card, never by a checking debit.
 */
function cardToCardPaymentEvidenceClaim(): (e: CcPaymentEvidence) => boolean {
  const rows = db
    .prepare(
      `SELECT c.financing_link_id, m.to_account_id, m.amount, m.occurred_on
         FROM card_to_card_payments c JOIN movements m ON m.id = c.movement_id`
    )
    .all() as { financing_link_id: number; to_account_id: number; amount: number; occurred_on: string }[];
  if (rows.length === 0) return () => false;
  /** (card, pesos, anchor day) the evidence may match. */
  const claims: { card: number; amount: number; day: string }[] = [];
  const byRecord = new Map<number, typeof rows>();
  for (const r of rows) {
    claims.push({ card: r.to_account_id, amount: Math.round(r.amount), day: r.occurred_on });
    byRecord.set(r.financing_link_id, [...(byRecord.get(r.financing_link_id) ?? []), r]);
  }
  for (const parts of byRecord.values()) {
    if (parts.length < 2) continue;
    const total = parts.reduce((s, p) => s + Math.round(p.amount), 0);
    const byDay = new Map<string, number>();
    for (const p of parts) byDay.set(p.occurred_on, (byDay.get(p.occurred_on) ?? 0) + Math.round(p.amount));
    for (const [day, sum] of byDay) {
      claims.push({ card: parts[0]!.to_account_id, amount: sum, day });
      claims.push({ card: parts[0]!.to_account_id, amount: total, day });
    }
  }
  return (e) =>
    e.currency === "clp" &&
    claims.some(
      (c) =>
        c.card === e.cc_account_id &&
        c.amount === Math.round(e.amount_clp) &&
        dayWithinWindow(c.day, e.pago_iso, MATCH_WINDOWS.financing_payment)
    );
}

export function listCcPaymentMirrorCandidates(): CcPaymentMirrorCandidate[] {
  const movements = db
    .prepare(
      `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on,
              m.amount, m.currency, m.counter_amount, m.counter_currency, m.note
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.account_id IS NOT NULL AND m.from_account_id IS NULL AND m.to_account_id IS NULL
         AND m.flow_kind IS NULL
         AND ${MOVEMENT_CLP_LEG_SQL} < 0
       ORDER BY m.occurred_on, m.id`
    )
    .all() as ({
    id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    note: string | null;
  } & MovementAmountFields)[];
  // Any account under Checking accounts can pay a card: the cuenta vista did, nine times between
  // 2019 and 2024, and those debits were never offered while this read the cuenta corriente only.
  const checkingIds = new Set(accountIdsUnderCheckingAccounts());
  const outs = movements.filter(
    (m) =>
      checkingIds.has(m.account_id) &&
      m.note != null &&
      (CC_PAYMENT_DESC_RE.test(m.note) || KHIPU_TRANSFER_DESC_RE.test(m.note)) &&
      // Paying the overdraft line is not a card payment (the shared description pattern keeps it:
      // for checking gastos it is an internal transfer all the same).
      !LINEA_CREDITO_PAYMENT_DESC_RE.test(m.note)
  );

  const evidenceRows = listCcPaymentEvidenceRows();
  const evidenceKeys = new Set(evidenceRows.map((r) => r.key));
  const pairings = listCcPaymentPairings();
  const lost = pairings.filter((p) => !evidenceKeys.has(p.key));
  if (lost.length > 0) {
    throw new Error(
      `${lost.length} converted card payment(s) have no card evidence left: ` +
        `${lost.map(describeCcPaymentPairing).join("; ")} — no card payment is paired until they are resolved ` +
        `(server/scripts/repair-cc-payment-mirror-evidence-refs.ts lists them)`
    );
  }
  const converted = new Set(pairings.map((p) => p.key));
  // A card payment entered by hand already has its transfer (from the account that paid): its
  // card line — planted, or the bank's line that replaced it — is not evidence for a checking debit.
  const claimedByManualPayment = manualPaymentEvidenceClaim();
  // A facturado another card paid: its PAGO is that card's transfer, not a checking debit's.
  const claimedByCardToCardPayment = cardToCardPaymentEvidenceClaim();
  const evidence = dedupeCcPaymentEvidence(evidenceRows).filter(
    (e) => !converted.has(ccPaymentEvidenceKey(e)) && !claimedByManualPayment(e) && !claimedByCardToCardPayment(e)
  );
  const byAmount = new Map<number, CcPaymentEvidence[]>();
  const foreignEvidence: CcPaymentEvidence[] = [];
  for (const e of evidence) {
    if (e.currency !== "clp") {
      foreignEvidence.push(e);
      continue;
    }
    const list = byAmount.get(e.amount_clp) ?? [];
    list.push(e);
    byAmount.set(e.amount_clp, list);
  }

  // Nearest-date matching, then bijectivity check: an evidence entry claimed by two
  // movements (or a movement with two equally-near evidence entries) blocks the pair.
  // A divisas debit pairs against USD evidence only (cross-currency, so no amount equality —
  // date window + fx band + uniqueness carry the match); every other payment debit pairs
  // against CLP evidence by exact amount.
  const picked: { out: (typeof outs)[number]; ev: CcPaymentEvidence; skew: number }[] = [];
  const ambiguous = new Set<number>();
  for (const out of outs) {
    const amount = Math.round(Math.abs(movementClpLegOrZero(out)));
    const isDivisas = DIVISAS_DESC_RE.test(out.note ?? "");
    // A divisas debit bought some foreign currency: it pairs with the card's abono in THAT
    // currency, at an implied rate inside the band around the currency's own rate that day.
    const pool = isDivisas
      ? foreignEvidence.filter((e) => {
          const rate = dayRateClp(e.currency, e.pago_iso);
          if (rate == null) return false;
          const implied = amount / (e.amount_foreign ?? Number.NaN);
          return implied >= DIVISAS_IMPLIED_RATE_BAND[0] * rate && implied <= DIVISAS_IMPLIED_RATE_BAND[1] * rate;
        })
      : byAmount.get(amount) ?? [];
    const { ranked: near, tiedAtTop } = rankByDistance(
      pool.filter((e) => dayWithinWindow(out.occurred_on, e.pago_iso, MATCH_WINDOWS.payment_mirror)),
      (e) => Math.abs(daysBetweenIso(e.pago_iso, out.occurred_on))
    );
    if (near.length === 0) continue;
    // The evidence stays in the list either way; a tie at the top blocks the pair (never a guess).
    if (tiedAtTop) ambiguous.add(out.id);
    picked.push({ out, ev: near[0]!.item, skew: near[0]!.d });
  }
  const evidenceClaims = new Map<string, number>();
  // One piece of evidence is one payment (card, date, currency, amount — the key the evidence list
  // is deduplicated on), not one statement row: a statement's header can carry several dated legs.
  const evKey = (e: CcPaymentEvidence) => ccPaymentEvidenceKey(e);
  for (const p of picked) {
    evidenceClaims.set(evKey(p.ev), (evidenceClaims.get(evKey(p.ev)) ?? 0) + 1);
  }

  return picked.map((p) => {
    const multiClaim = (evidenceClaims.get(evKey(p.ev)) ?? 0) > 1;
    const isAmbiguous = ambiguous.has(p.out.id) || multiClaim;
    return {
      out: {
        movement_id: p.out.id,
        account_id: p.out.account_id,
        account_name: p.out.account_name,
        occurred_on: p.out.occurred_on,
        amount_clp: movementClpLegOrZero(p.out),
        note: p.out.note,
      },
      evidence: p.ev,
      skew_days: daysBetweenIso(p.ev.pago_iso, p.out.occurred_on),
      blocked: isAmbiguous,
      blocked_reason: isAmbiguous ? "ambiguous match (multiple pairs at equal distance)" : null,
    };
  });
}

export type ConvertedCcPaymentMirror = {
  transfer_movement_id: number;
  out_movement_id: number;
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
};

/**
 * Converts CC-payment pairs in one all-or-nothing transaction; every ref must be a current,
 * unblocked candidate. The checking leg is deleted (snapshotted in movement_mirror_merges);
 * the statement evidence is never touched. The transfer's card leg (card, credit date, card-side
 * amount) is what ties the pair to its evidence from then on; the evidence row ids written into
 * movement_mirror_merges only record what the conversion saw.
 */
export function convertCcPaymentMirrors(refs: CcPaymentMirrorRef[]): {
  converted: ConvertedCcPaymentMirror[];
} {
  if (refs.length === 0) return { converted: [] };
  const insTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
     VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
  );
  const insMerge = db.prepare(
    `INSERT INTO movement_mirror_merges (
       transfer_movement_id,
       out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_statement_line_id, in_statement_id, in_occurred_on, in_amount_clp, in_note
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
  const delIncomeOverride = db.prepare(
    `DELETE FROM flow_income_overrides WHERE flow_id = (SELECT flow_id FROM movements WHERE id = ?)`
  );
  const delLeg = db.prepare(`DELETE FROM movements WHERE id = ?`);

  const run = db.transaction((requested: CcPaymentMirrorRef[]): ConvertedCcPaymentMirror[] => {
    const candidates = new Map(
      listCcPaymentMirrorCandidates().map((c) => [
        `${c.out.movement_id}|${c.evidence.statement_line_id ?? ""}|${c.evidence.statement_id ?? ""}`,
        c,
      ])
    );
    const converted: ConvertedCcPaymentMirror[] = [];
    for (const ref of requested) {
      const key = `${ref.out_movement_id}|${ref.statement_line_id ?? ""}|${ref.statement_id ?? ""}`;
      const cand = candidates.get(key);
      if (!cand) throw new Error(`cc payment mirror ${key}: not a current candidate`);
      if (cand.blocked) throw new Error(`cc payment mirror ${key}: ${cand.blocked_reason}`);

      // USD evidence has no peso amount: the transfer's CLP leg is the checking debit itself
      // (the exact pesos that left the account), and the card side rides as the USD counter
      // leg — the migration-169 cross-currency transfer shape.
      const isForeign = cand.evidence.currency !== "clp";
      const transferClp = isForeign ? Math.round(Math.abs(cand.out.amount_clp)) : cand.evidence.amount_clp;
      const note = isForeign
        ? `Pago tarjeta espejo (divisas: cargo cuenta ${cand.out.occurred_on} → abono tarjeta ${foreignPaymentAmountLabel(cand.evidence.amount_foreign!, cand.evidence.currency)} ${cand.evidence.pago_iso})`
        : `Pago tarjeta espejo (cargo cuenta ${cand.out.occurred_on} → abono tarjeta ${cand.evidence.pago_iso})`;
      const r = insTransfer.run(
        cand.out.account_id,
        cand.evidence.cc_account_id,
        transferClp,
        isForeign ? cand.evidence.amount_foreign : null,
        isForeign ? cand.evidence.currency : null,
        cand.evidence.pago_iso,
        note,
        FLOW_KIND_PAGO_TARJETA
      );
      insMerge.run(
        Number(r.lastInsertRowid),
        cand.out.movement_id,
        cand.out.occurred_on,
        cand.out.amount_clp,
        null,
        cand.out.note,
        cand.evidence.statement_line_id,
        cand.evidence.statement_id,
        cand.evidence.pago_iso,
        -transferClp,
        cand.evidence.label
      );
      // The deleted checking row was the bank's listing: its date is the transfer's posting
      // day on checking, while the transfer itself takes the card's credit date.
      recordBankPosting(Number(r.lastInsertRowid), cand.out.account_id, cand.out.occurred_on);
      delIncomeOverride.run(cand.out.movement_id);
      delLeg.run(cand.out.movement_id);
      converted.push({
        transfer_movement_id: Number(r.lastInsertRowid),
        out_movement_id: cand.out.movement_id,
        from_account_id: cand.out.account_id,
        to_account_id: cand.evidence.cc_account_id,
        occurred_on: cand.evidence.pago_iso,
      });
    }
    return converted;
  });

  return { converted: run(refs) };
}
