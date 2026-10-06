/**
 * When a facturación's billed cuotas actually LEAVE the «deuda en cuotas» line.
 *
 * The schedule frame drops a cycle's cuotas at its pay-by (PAGAR HASTA), but the real
 * payment usually lands days earlier — the bank frees «cupo utilizado en cuotas» the day
 * the payment posts, so between the payment and the pay-by the schedule frame overstates
 * installment debt and the daily chart showed «deuda en cuotas» ABOVE «saldo total»
 * (payments 2025-01-31, 2026-02-27, … on the ·0781 master). This module dates each
 * facturación's cuota drop at the real CLP payment when statement evidence exists, and
 * falls back to the pay-by when it does not — so an evidence-less month behaves exactly
 * as before.
 *
 * Attribution (a payment is not labeled with its facturación):
 *   1. Exact pass: a payment whose amount equals a closed facturación's CLP facturado
 *      (oldest such, close on/before the payment date) pays that facturación wholly.
 *      Exact-first prevents the off-by-one cascade an evidence hole would cause: with
 *      accumulate-only, one undated payment (fact 2025-10) makes every later payment
 *      land one facturación back.
 *   2. Accumulate pass: remaining payments (partial/multi-leg months, e.g. the Feb-2025
 *      8.xxx.xxx paid 3M + 3M + 2.xxx.xxx) fill the oldest closed facturación with
 *      capacity left, spilling forward.
 *   Within a facturación the cuota component retires FIRST (cuotas-first): it is the only
 *   whole-peso rule that keeps saldo total ≥ deuda en cuotas mid-cycle — cuotas-last
 *   recreates the crossing as soon as cumulative payments exceed facturado − cuota.
 *   A payment dated after the pay-by retires late (frame-consistent with the owed walk);
 *   leftover pesos with no closed facturación to pay are discarded.
 */
import { cacheKeyCcBillingDetail, getAggregationCached } from "./aggregationCache.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { isCcPaymentMerchant, requireHeaderPagoIso } from "./ccPaymentLines.js";
import { db } from "./db.js";

export type ClpPaymentEvent = { iso: string; clp: number };

export type CuotaRetirementMonth = {
  /** Billing month (YYYY-MM). */
  month: string;
  /** Plan cuotas billed at this month's close (0 for capacity-only months). */
  cuota_clp: number;
  /** Fallback drop date (PAGAR HASTA / derived ~10th); null = month cannot drop at all. */
  pay_by_iso: string | null;
  /** Statement close date; null = not closed (open/projected/manual) — never evidence-paid. */
  close_iso: string | null;
  /** CLP facturado (payment capacity); null = header unknown, capacity clamps to the cuota. */
  facturado_clp: number | null;
};

export type CuotaRetirementResult = {
  /** Dated cuota drops (positive pesos) for the daily deuda-en-cuotas walk. */
  drops: { iso: string; clp: number }[];
  /** Billing month → date its cuota component fully retired via payment evidence. */
  retired_on_by_month: Map<string, string>;
};

/**
 * Dated CLP payments of billed debt for one CC master: payment lines (`isCcPaymentMerchant`
 * — PAGO, MONTO CANCELADO, ABONO, the same test as the open-month sums) plus header-only
 * pagados (`monto_pagado_anterior` + printed date, migration 166) and the dated legs of the
 * header pagados printed without a date (`cc_header_payment_legs`, migration 213). The mirror-pair evidence
 * collector (`ccPaymentMirrors.ts`) reads the same lines and headers through the same
 * predicate and date readers. Versions and the legacy line+header double-description of one
 * payment collapse on (date, amount), lines preferred. USD-debt abonos (ABONO DE DIVISAS) are
 * not payments here: cuotas are CLP and a divisas payment never pays the CLP facturado.
 */
export function listClpCcPaymentEventsForAccount(accountId: number): ClpPaymentEvent[] {
  return getAggregationCached(`${cacheKeyCcBillingDetail(accountId)}|clp_pago_events`, () => {
    const lineRows = db
      .prepare(
        `SELECT l.transaction_date, l.amount_clp, l.merchant
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND s.currency = 'clp'
           AND l.installment_flag = 0 AND l.amount_clp < 0`
      )
      .all(accountId) as {
      transaction_date: string | null;
      amount_clp: number;
      merchant: string | null;
    }[];
    const headerRows = db
      .prepare(
        `SELECT statement_date, monto_pagado_anterior AS amt, monto_pagado_anterior_date AS pago_iso
         FROM cc_statements
         WHERE account_id = ? AND currency = 'clp'
           AND monto_pagado_anterior IS NOT NULL AND monto_pagado_anterior_date IS NOT NULL`
      )
      .all(accountId) as { statement_date: string; amt: number; pago_iso: string }[];

    // The dated legs of header payments the statement printed undated (migration 213).
    const legRows = db
      .prepare(`SELECT paid_on, amount_clp FROM cc_header_payment_legs WHERE account_id = ?`)
      .all(accountId) as { paid_on: string; amount_clp: number }[];

    const byKey = new Map<string, ClpPaymentEvent>();
    for (const r of lineRows) {
      if (!isCcPaymentMerchant(r.merchant)) continue;
      const iso = normalizeTransactionDateIso(r.transaction_date);
      if (!iso) continue;
      const clp = Math.round(Math.abs(r.amount_clp));
      if (clp === 0) continue;
      const key = `${iso}|${clp}`;
      if (!byKey.has(key)) byKey.set(key, { iso, clp });
    }
    for (const r of headerRows) {
      const clp = Math.round(Math.abs(r.amt));
      if (clp === 0) continue;
      const iso = requireHeaderPagoIso(r.statement_date, r.pago_iso);
      const key = `${iso}|${clp}`;
      if (!byKey.has(key)) byKey.set(key, { iso, clp });
    }
    for (const r of legRows) {
      const key = `${r.paid_on}|${r.amount_clp}`;
      if (!byKey.has(key)) byKey.set(key, { iso: r.paid_on, clp: r.amount_clp });
    }
    return [...byKey.values()].sort((a, b) => a.iso.localeCompare(b.iso));
  });
}

/**
 * CLP facturado header by statement close date (ISO) for one CC master — the payment
 * capacity source for callers that assemble retirement months without the facturaciones
 * view (the installment months builder, which the billing-detail cache builds ON TOP of —
 * reading the view from there would recurse).
 */
export function clpFacturadoByCloseIso(accountId: number): Map<string, number> {
  return getAggregationCached(
    `${cacheKeyCcBillingDetail(accountId)}|clp_facturado_by_close`,
    () => {
      const rows = db
        .prepare(
          `SELECT statement_date, monto_facturado AS amt
           FROM cc_statements
           WHERE account_id = ? AND currency = 'clp'
             AND monto_facturado IS NOT NULL AND monto_facturado > 0`
        )
        .all(accountId) as { statement_date: string; amt: number }[];
      const out = new Map<string, number>();
      for (const r of rows) {
        const iso = normalizeTransactionDateIso(r.statement_date);
        if (!iso) continue;
        if (!out.has(iso)) out.set(iso, Math.round(r.amt));
      }
      return out;
    }
  );
}

const EXACT_MATCH_TOL_CLP = 2;

/** Pure retirement computation — see the module doc for the attribution rules. */
export function computeCuotaRetirements(
  months: readonly CuotaRetirementMonth[],
  payments: readonly ClpPaymentEvent[]
): CuotaRetirementResult {
  const ms = months
    .map((m) => ({
      month: m.month,
      payByIso: m.pay_by_iso,
      closeIso: m.close_iso,
      cuotaLeft: Math.max(0, Math.round(m.cuota_clp)),
      // A payment can never cover more than the facturado; an unknown header still must
      // let an attributed payment retire the cuota it bills.
      capacityLeft: Math.max(
        m.facturado_clp != null ? Math.round(m.facturado_clp) : 0,
        Math.max(0, Math.round(m.cuota_clp))
      ),
      evidenceRetiredOn: null as string | null,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const pays = [...payments]
    .filter((p) => Number.isFinite(p.clp) && p.clp > 0)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  const drops: { iso: string; clp: number }[] = [];
  const retire = (m: (typeof ms)[number], iso: string, clp: number): void => {
    if (clp <= 0) return;
    drops.push({ iso, clp });
    m.cuotaLeft -= clp;
    if (m.cuotaLeft <= 0) m.evidenceRetiredOn = iso;
  };

  // Pass 1 — exact facturado matches claim their facturación wholly.
  const exactMatched = new Set<ClpPaymentEvent>();
  for (const p of pays) {
    const m = ms.find(
      (x) =>
        x.closeIso != null &&
        x.closeIso <= p.iso &&
        x.capacityLeft > 0 &&
        Math.abs(x.capacityLeft - p.clp) <= EXACT_MATCH_TOL_CLP
    );
    if (!m) continue;
    exactMatched.add(p);
    retire(m, p.iso, Math.min(m.cuotaLeft, p.clp));
    m.capacityLeft = 0;
  }

  // Pass 2 — partial/multi-leg payments accumulate oldest-first, cuotas-first.
  for (const p of pays) {
    if (exactMatched.has(p)) continue;
    let amt = p.clp;
    for (const m of ms) {
      if (amt <= 0) break;
      if (m.closeIso == null || m.closeIso > p.iso || m.capacityLeft <= 0) continue;
      const applied = Math.min(amt, m.capacityLeft);
      retire(m, p.iso, Math.min(m.cuotaLeft, applied));
      m.capacityLeft -= applied;
      amt -= applied;
    }
  }

  // Remainders (no evidence, or evidence short of the cuota) keep the schedule frame.
  const retired_on_by_month = new Map<string, string>();
  for (const m of ms) {
    if (m.cuotaLeft > 0) {
      if (m.payByIso != null) drops.push({ iso: m.payByIso, clp: m.cuotaLeft });
      continue;
    }
    if (m.evidenceRetiredOn != null) retired_on_by_month.set(m.month, m.evidenceRetiredOn);
  }
  return { drops, retired_on_by_month };
}
