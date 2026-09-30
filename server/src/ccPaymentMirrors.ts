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
import { recordBankPosting } from "./movementBankPostings.js";
import { invalidateAggregationForAccountDate, invalidateCcBillingDetail } from "./aggregationCache.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { CC_PAYMENT_DESC_RE } from "./checkingDescriptionPredicates.js";
import {
  ccPaymentEvidenceKey,
  describeCcPaymentPairing,
  listCcPaymentEvidenceRows,
  listCcPaymentPairings,
} from "./ccPaymentMirrorEvidence.js";
import { db } from "./db.js";
import { movementClpLegOrZero, type MovementAmountFields } from "./movementAmounts.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";

const MATCH_WINDOW_DAYS = 4;

/**
 * Checking legs of USD-debt payments («Egreso por Compra de Divisas»). Cross-currency, so the
 * pairing to the card's ABONO DE DIVISAS cannot be amount-exact: it is date-window + one-to-one
 * uniqueness, plus an implied-fx sanity band so a coincidental unrelated fx purchase cannot pair
 * with a card abono of a very different size.
 */
const DIVISAS_DESC_RE = /COMPRA\s+DE\s+DIVISAS/i;
const DIVISAS_IMPLIED_FX_MIN = 300;
const DIVISAS_IMPLIED_FX_MAX = 2000;

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
  /** 'usd' = ABONO DE DIVISAS on the USD statement (the divisas payment's card leg). */
  currency: "clp" | "usd";
  /** Positive USD amount for usd evidence; null for clp. */
  amount_usd: number | null;
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

function dayDiff(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

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
      amount_usd: r.amount_usd,
      label: r.label,
    });
  }
  return [...byKey.values()];
}

/**
 * Candidates: single-leg checking debits whose note matches the card-payment description,
 * paired to payment evidence by exact amount within ±4 days (nearest date wins; ambiguity
 * blocks both sides — fail closed, never guess). Already-converted payments are excluded by the
 * payment's key, so a re-imported statement's new rows are not offered again. Throws while a
 * converted payment has lost its evidence: if the payment came back under another date it would
 * look unconverted, and pairing it again would book it twice.
 */
export function listCcPaymentMirrorCandidates(): CcPaymentMirrorCandidate[] {
  const movements = db
    .prepare(
      `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on,
              m.amount, m.currency, m.counter_amount, m.counter_currency, m.note
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.account_id IS NOT NULL AND m.from_account_id IS NULL AND m.to_account_id IS NULL
         AND m.flow_kind IS NULL
         AND (CASE WHEN m.currency = 'clp' THEN m.amount WHEN m.counter_currency = 'clp' THEN m.counter_amount ELSE 0 END) < 0
       ORDER BY m.occurred_on, m.id`
    )
    .all() as ({
    id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    note: string | null;
  } & MovementAmountFields)[];
  const outs = movements.filter(
    (m) =>
      accountKindSlugForAccountId(m.account_id) === "cuenta_corriente" &&
      m.note != null &&
      CC_PAYMENT_DESC_RE.test(m.note)
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
  const evidence = dedupeCcPaymentEvidence(evidenceRows).filter(
    (e) => !converted.has(ccPaymentEvidenceKey(e))
  );
  const byAmount = new Map<number, CcPaymentEvidence[]>();
  const usdEvidence: CcPaymentEvidence[] = [];
  for (const e of evidence) {
    if (e.currency === "usd") {
      usdEvidence.push(e);
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
    const pool = isDivisas
      ? usdEvidence.filter((e) => {
          const fx = amount / (e.amount_usd ?? Number.NaN);
          return fx >= DIVISAS_IMPLIED_FX_MIN && fx <= DIVISAS_IMPLIED_FX_MAX;
        })
      : byAmount.get(amount) ?? [];
    const near = pool
      .map((e) => ({ e, d: Math.abs(dayDiff(out.occurred_on, e.pago_iso)) }))
      .filter((x) => x.d <= MATCH_WINDOW_DAYS)
      .sort((a, b) => a.d - b.d);
    if (near.length === 0) continue;
    if (near.length > 1 && near[0]!.d === near[1]!.d) {
      ambiguous.add(out.id);
      picked.push({ out, ev: near[0]!.e, skew: near[0]!.d });
      continue;
    }
    picked.push({ out, ev: near[0]!.e, skew: near[0]!.d });
  }
  const evidenceClaims = new Map<string, number>();
  const evKey = (e: CcPaymentEvidence) => `${e.statement_line_id ?? ""}|${e.statement_id ?? ""}`;
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
      skew_days: dayDiff(p.out.occurred_on, p.ev.pago_iso),
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
    `DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`
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
      const isUsd = cand.evidence.currency === "usd";
      const transferClp = isUsd ? Math.round(Math.abs(cand.out.amount_clp)) : cand.evidence.amount_clp;
      const note = isUsd
        ? `Pago tarjeta espejo (divisas: cargo cuenta ${cand.out.occurred_on} → abono tarjeta US$${cand.evidence.amount_usd!.toFixed(2)} ${cand.evidence.pago_iso})`
        : `Pago tarjeta espejo (cargo cuenta ${cand.out.occurred_on} → abono tarjeta ${cand.evidence.pago_iso})`;
      const r = insTransfer.run(
        cand.out.account_id,
        cand.evidence.cc_account_id,
        transferClp,
        isUsd ? cand.evidence.amount_usd : null,
        isUsd ? "usd" : null,
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

  const converted = run(refs);
  for (const c of converted) {
    const merge = db
      .prepare(`SELECT out_occurred_on FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
      .get(c.transfer_movement_id) as { out_occurred_on: string };
    const earliest = merge.out_occurred_on < c.occurred_on ? merge.out_occurred_on : c.occurred_on;
    clearCheckingBalanceCache(c.from_account_id);
    invalidateAggregationForAccountDate(c.from_account_id, earliest);
    invalidateAggregationForAccountDate(c.to_account_id, earliest);
    invalidateCcBillingDetail(c.to_account_id);
  }
  return { converted };
}
