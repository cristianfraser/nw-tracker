import { payByFxDateIso } from "./ccBillingBalances.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import {
  listCcPaymentEvidenceRows,
  listCcPaymentPairings,
  type CcPaymentPairing,
} from "./ccPaymentMirrorEvidence.js";
import { isCcTraspasoDeudaMerchant } from "./ccStatementSection3.js";
import { ccTraspasoLinkedClpByUsdLineId } from "./ccTraspasoDeudaLinks.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { fxForLiveMtm } from "./fxLive.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { usdOutflowPesoCostByMovement } from "./usdCashCostLots.js";

/**
 * `paid` = the rate the facturación's dollar debt was actually paid at; `live` = still unpaid and
 * its pay-by is ahead, so today's rate; `pay_by` = its pay-by passed with no payment on file (an
 * older facturación paid by means the data does not record), valued like its debt (pay-by − 1).
 */
export type FacturacionUsdRateSource = "paid" | "pay_by" | "live";

export type FacturacionUsdRate = {
  clp_per_usd: number;
  source: FacturacionUsdRateSource;
  /** USD of the payments behind a `paid` rate (0 otherwise). */
  paid_usd: number;
};

/** One payment of a card's dollar debt, in both currencies. */
export type UsdDebtPayment = { date_iso: string; clp: number; usd: number };

type FacturacionWindowRow = {
  billing_month: string;
  close_date_iso: string;
  pay_by_iso: string | null;
};

/** The facturaciones by close; two on one close could not tell whose payments follow it. */
function sortedByDistinctClose<T extends FacturacionWindowRow>(facturaciones: readonly T[]): T[] {
  const sorted = [...facturaciones].sort((a, b) => a.close_date_iso.localeCompare(b.close_date_iso));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.close_date_iso === sorted[i - 1]!.close_date_iso) {
      throw new Error(
        `facturaciones ${sorted[i - 1]!.billing_month} and ${sorted[i]!.billing_month} share the close ${sorted[i]!.close_date_iso}`
      );
    }
  }
  return sorted;
}

/**
 * The facturación a dollar debt payment made on `dateIso` pays: the last one closed before that
 * day — payments after close M and up to close M+1 pay what M billed, so a payment on a close day
 * pays the previous facturación. Null before the first close. `sorted` by close.
 */
function facturacionPaidOn<T extends FacturacionWindowRow>(sorted: readonly T[], dateIso: string): T | null {
  let paid: T | null = null;
  for (const f of sorted) {
    if (f.close_date_iso >= dateIso) break;
    paid = f;
  }
  return paid;
}

/**
 * The USD/CLP rate each facturación SHOWS its dollar charges at — its row, the historial bars
 * and its expense lines (the facturación modal), so the lines add up to the row. A dollar debt
 * payment belongs to the facturación whose close it follows ({@link facturacionPaidOn}). Their
 * weighted rate (Σ pesos ÷ Σ dollars) is the facturación's rate; without any, today's rate while
 * the pay-by is still ahead (the pay-by day included), else the pay-by − 1 debt rate. Pure: the
 * payments and rates come in from the caller.
 */
export function facturacionUsdRates(
  facturaciones: readonly FacturacionWindowRow[],
  payments: readonly UsdDebtPayment[],
  opts: { todayYmd: string; payByRate: (payByIso: string) => number; liveRate: () => number }
): Map<string, FacturacionUsdRate> {
  const sorted = sortedByDistinctClose(facturaciones);
  const paidByMonth = new Map<string, { clp: number; usd: number }>();
  for (const p of payments) {
    const f = facturacionPaidOn(sorted, p.date_iso);
    if (!f) continue;
    const paid = paidByMonth.get(f.billing_month) ?? { clp: 0, usd: 0 };
    paid.clp += p.clp;
    paid.usd += p.usd;
    paidByMonth.set(f.billing_month, paid);
  }
  let live: number | null = null;
  const out = new Map<string, FacturacionUsdRate>();
  for (const f of sorted) {
    const paid = paidByMonth.get(f.billing_month);
    if (paid && paid.usd > 0) {
      out.set(f.billing_month, { clp_per_usd: paid.clp / paid.usd, source: "paid", paid_usd: paid.usd });
    } else if (f.pay_by_iso != null && f.pay_by_iso < opts.todayYmd) {
      out.set(f.billing_month, { clp_per_usd: opts.payByRate(f.pay_by_iso), source: "pay_by", paid_usd: 0 });
    } else {
      live ??= opts.liveRate();
      out.set(f.billing_month, { clp_per_usd: live, source: "live", paid_usd: 0 });
    }
  }
  return out;
}

const stmtDivisasPayments = db.prepare(
  `SELECT id, occurred_on AS date_iso, amount AS clp, counter_amount AS usd
   FROM movements
   WHERE flow_kind = 'pago_tarjeta' AND to_account_id = ?
     AND currency = 'clp' AND counter_currency = 'usd'`
);

const stmtDollarPayments = db.prepare(
  `SELECT id, from_account_id, occurred_on AS date_iso, amount AS usd
   FROM movements
   WHERE flow_kind = 'pago_tarjeta' AND to_account_id = ? AND account_id IS NULL
     AND currency = 'usd' AND counter_currency IS NULL`
);

const stmtTraspasoPayments = db.prepare(
  `SELECT t.id, l.transaction_date, t.amount_clp AS clp, t.amount_usd AS usd
   FROM cc_traspaso_deuda_links t
   INNER JOIN cc_statement_lines l ON l.id = t.usd_line_id
   WHERE t.account_id = ?`
);

/**
 * A card's dollar debt payments: the divisas purchases paired with its ABONO DE DIVISAS lines
 * (`pago_tarjeta` transfers with a USD counter leg — the pesos that left checking and the
 * dollars the card was credited), the payments made in dollars from a USD cash account
 * (`pago_tarjeta` with `currency = 'usd'` and no counter leg: the pesos those dollars cost, traced
 * by `usdCashCostLots.ts`) and the traspasos de deuda (the bank moving the dollar debt to the peso
 * side at its own rate, `cc_traspaso_deuda_links`).
 */
export function usdDebtPaymentsForAccount(accountId: number): UsdDebtPayment[] {
  const out: UsdDebtPayment[] = [];
  for (const r of stmtDivisasPayments.all(accountId) as {
    id: number;
    date_iso: string;
    clp: number;
    usd: number | null;
  }[]) {
    if (!(r.clp > 0) || r.usd == null || !(r.usd > 0)) {
      throw new Error(`pago_tarjeta movement ${r.id}: a dollar payment needs positive pesos and dollars`);
    }
    out.push({ date_iso: r.date_iso, clp: r.clp, usd: r.usd });
  }
  const dollarPayments = stmtDollarPayments.all(accountId) as {
    id: number;
    from_account_id: number | null;
    date_iso: string;
    usd: number;
  }[];
  if (dollarPayments.length > 0) {
    const costs = usdOutflowPesoCostByMovement();
    for (const r of dollarPayments) {
      if (r.from_account_id == null || !isUsdCashAccount(r.from_account_id)) {
        throw new Error(`pago_tarjeta movement ${r.id}: a payment in dollars must leave a USD cash account`);
      }
      const cost = costs.get(r.id);
      if (!cost) throw new Error(`pago_tarjeta movement ${r.id}: the dollar cost tracer did not price it`);
      if (Math.round(cost.usd * 100) !== Math.round(r.usd * 100) || !(r.usd > 0)) {
        throw new Error(`pago_tarjeta movement ${r.id}: priced US$${cost.usd} for a US$${r.usd} payment`);
      }
      out.push({ date_iso: r.date_iso, clp: cost.clp, usd: r.usd });
    }
  }
  for (const r of stmtTraspasoPayments.all(accountId) as {
    id: number;
    transaction_date: string | null;
    clp: number;
    usd: number;
  }[]) {
    const date_iso = parseDdMmYyToIso(String(r.transaction_date ?? ""));
    if (!date_iso) {
      throw new Error(`traspaso link ${r.id}: unparsable USD line date ${JSON.stringify(r.transaction_date)}`);
    }
    out.push({ date_iso, clp: r.clp, usd: r.usd });
  }
  return out;
}

/**
 * A card line that pays dollar debt: a dollar credit that is a payment (ABONO DE DIVISAS, a PAGO or
 * MONTO CANCELADO in dollars) or a traspaso de deuda's USD leg.
 */
export function isCcUsdPaymentLine(line: {
  installment_flag: number;
  merchant: string | null;
  usd: number;
}): boolean {
  if (line.installment_flag === 1 || !(line.usd < 0)) return false;
  return isCcPaymentOrUsdDebtAbonoMerchant(line.merchant) || isCcTraspasoDeudaMerchant(line.merchant);
}

export type CcUsdPaymentLine = { statement_line_id: number; date_iso: string | null; usd: number };

/**
 * The pesos a dollar payment line ({@link isCcUsdPaymentLine}) shows: what was actually paid for
 * it. It is printed on the statement after the facturación it pays, so the rate of the facturación
 * whose statement prints it is the wrong one. In order:
 * - a divisas purchase paired with the line's payment: its pesos. The line must be divisas payment
 *   evidence (`listCcPaymentEvidenceRows`: an ABONO DE DIVISAS no traspaso claims) and the converted
 *   payment (`listCcPaymentPairings`) the one with its card, date and dollars — whichever statement
 *   row printed that payment when it was paired;
 * - a traspaso de deuda's USD leg (`cc_traspaso_deuda_links`): minus its CLP leg's booked pesos, as
 *   the owed walk values it;
 * - otherwise the rate of the facturación it paid ({@link facturacionPaidOn} — the window that
 *   facturación's paid rate sums over), `facturacionRate` being the rate its row shows.
 * A line that fits none — no date, or dated before the card's first close — throws.
 */
export function usdPaymentLineClpResolver(
  accountId: number,
  facturaciones: readonly FacturacionWindowRow[],
  facturacionRate: (billingMonth: string) => number
): (line: CcUsdPaymentLine) => number {
  const divisasByKey = new Map<string, CcPaymentPairing>();
  for (const p of listCcPaymentPairings(accountId)) {
    if (p.currency === "usd") divisasByKey.set(p.key, p);
  }
  const divisasByLine = new Map<number, CcPaymentPairing>();
  for (const r of listCcPaymentEvidenceRows(accountId)) {
    const paired = r.currency === "usd" ? divisasByKey.get(r.key) : undefined;
    if (paired) divisasByLine.set(r.id, paired);
  }
  const traspasoClpByLine = ccTraspasoLinkedClpByUsdLineId(accountId);
  const sorted = sortedByDistinctClose(facturaciones);
  return (line) => {
    const divisas = divisasByLine.get(line.statement_line_id);
    if (divisas) return -divisas.amount_clp;
    const traspasoClp = traspasoClpByLine.get(line.statement_line_id);
    if (traspasoClp != null) return -traspasoClp;
    if (!line.date_iso) {
      throw new Error(`Account ${accountId}: dollar payment line ${line.statement_line_id} has no date`);
    }
    const paid = facturacionPaidOn(sorted, line.date_iso);
    if (!paid) {
      throw new Error(
        `Account ${accountId}: dollar payment line ${line.statement_line_id} (${line.date_iso}) precedes every facturación close — no facturación it paid`
      );
    }
    return Math.round(line.usd * facturacionRate(paid.billing_month));
  };
}

const stmtHasUsdStatement = db.prepare(
  `SELECT 1 FROM cc_statements WHERE account_id = ? AND currency = 'usd' LIMIT 1`
);

/** Whether the card ever billed in dollars — only then do its facturaciones need a USD rate. */
export function accountHasUsdStatements(accountId: number): boolean {
  return stmtHasUsdStatement.get(accountId) != null;
}

/** {@link facturacionUsdRates} over the account's own payments, at `now`'s Chile date. */
export function facturacionUsdRatesForAccount(
  accountId: number,
  facturaciones: readonly FacturacionWindowRow[],
  now: Date = new Date()
): Map<string, FacturacionUsdRate> {
  const todayYmd = chileWallClockAt(now).ymd;
  return facturacionUsdRates(facturaciones, usdDebtPaymentsForAccount(accountId), {
    todayYmd,
    payByRate: (payByIso) => {
      const fx = fxMonthEndForBalanceUsd(payByFxDateIso(payByIso));
      if (!fx || !(fx.clp_per_usd > 0)) {
        throw new Error(`Account ${accountId}: no USD/CLP rate on or before ${payByFxDateIso(payByIso)}`);
      }
      return fx.clp_per_usd;
    },
    liveRate: () => {
      const fx = fxForLiveMtm(todayYmd, now);
      if (!fx || !(fx.clp_per_usd > 0)) {
        throw new Error(`Account ${accountId}: no USD/CLP rate for ${todayYmd}`);
      }
      return fx.clp_per_usd;
    },
  });
}
