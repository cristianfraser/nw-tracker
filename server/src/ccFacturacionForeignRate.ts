import { isForeignCashAccountIn } from "./foreignCashAccounts.js";
import { payByFxDateIso } from "./ccBillingBalances.js";
import {
  listCcPaymentEvidenceRows,
  listCcPaymentPairings,
  type CcPaymentPairing,
} from "./ccPaymentMirrorEvidence.js";
import { ccTraspasoLinkedClpByForeignLineId } from "./ccTraspasoDeudaLinks.js";
import { currencyMinorDigits, isHomeCurrency } from "./displayUnits.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { traspasoForeignLegs } from "./cards/purchases.js";
import { convertCurrency } from "./rates.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { fxForLiveMtm } from "./fxLive.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";

import { foreignOutflowPesoCostByMovement } from "./foreignCashCostLots.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

/**
 * Per foreign currency a card bills in (docs/any-currency-plan.md C3): `paid` = the rate the
 * facturación's debt in that currency was actually paid at; `live` = still unpaid and its pay-by is
 * ahead, so today's rate; `pay_by` = its pay-by passed with no payment on file (an older facturación
 * paid by means the data does not record), valued like its debt (pay-by − 1).
 */
export type FacturacionForeignRateSource = "paid" | "pay_by" | "live";

export type FacturacionForeignRate = {
  /** Pesos per unit of the currency. */
  clp_per_unit: number;
  source: FacturacionForeignRateSource;
  /** Amount, in the currency, of the payments behind a `paid` rate (0 otherwise). */
  paid_amount: number;
};

/** One payment of a card's debt in a foreign currency: the pesos it cost and the amount it paid. */
export type ForeignDebtPayment = { date_iso: string; clp: number; amount: number };

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
 * The rate each facturación SHOWS its charges in one foreign currency at — its row, the historial
 * bars and its expense lines (the facturación modal), so the lines add up to the row. A payment of
 * that debt belongs to the facturación whose close it follows ({@link facturacionPaidOn}). Their
 * weighted rate (Σ pesos ÷ Σ amount) is the facturación's rate; without any, today's rate while the
 * pay-by is still ahead (the pay-by day included), else the pay-by − 1 debt rate. Pure: the
 * payments and rates come in from the caller.
 */
export function facturacionForeignRates(
  facturaciones: readonly FacturacionWindowRow[],
  payments: readonly ForeignDebtPayment[],
  opts: { todayYmd: string; payByRate: (payByIso: string) => number; liveRate: () => number }
): Map<string, FacturacionForeignRate> {
  const sorted = sortedByDistinctClose(facturaciones);
  const paidByMonth = new Map<string, { clp: number; amount: number }>();
  for (const p of payments) {
    const f = facturacionPaidOn(sorted, p.date_iso);
    if (!f) continue;
    const paid = paidByMonth.get(f.billing_month) ?? { clp: 0, amount: 0 };
    paid.clp += p.clp;
    paid.amount += p.amount;
    paidByMonth.set(f.billing_month, paid);
  }
  let live: number | null = null;
  const out = new Map<string, FacturacionForeignRate>();
  for (const f of sorted) {
    const paid = paidByMonth.get(f.billing_month);
    if (paid && paid.amount > 0) {
      out.set(f.billing_month, { clp_per_unit: paid.clp / paid.amount, source: "paid", paid_amount: paid.amount });
    } else if (f.pay_by_iso != null && f.pay_by_iso < opts.todayYmd) {
      out.set(f.billing_month, { clp_per_unit: opts.payByRate(f.pay_by_iso), source: "pay_by", paid_amount: 0 });
    } else {
      live ??= opts.liveRate();
      out.set(f.billing_month, { clp_per_unit: live, source: "live", paid_amount: 0 });
    }
  }
  return out;
}

const stmtDivisasPayments = db.prepare(
  `SELECT id, occurred_on AS date_iso, amount AS clp, counter_amount AS amount
   FROM movements
   WHERE flow_kind = 'pago_tarjeta' AND to_account_id = ?
     AND currency = 'clp' AND counter_currency = ?`
);

const stmtForeignCashPayments = db.prepare(
  `SELECT id, from_account_id, occurred_on AS date_iso, amount
   FROM movements
   WHERE flow_kind = 'pago_tarjeta' AND to_account_id = ? AND account_id IS NULL
     AND currency = ? AND counter_currency IS NULL`
);

/**
 * A card's payments of its debt in `currency` (any foreign currency it bills in): the divisas
 * purchases paired with its ABONO DE DIVISAS lines (`pago_tarjeta` transfers with a counter leg in
 * that currency — the pesos that left checking and the amount the card was credited), the payments
 * made in that currency from a foreign cash account holding it (`pago_tarjeta` in the currency with
 * no counter leg: the pesos that money cost, traced by `foreignCashCostLots.ts`) and the traspasos
 * de deuda out of it (the bank moving that debt to the peso side at its own rate,
 * `cc_traspaso_deuda_links`).
 */
export function foreignDebtPaymentsForAccount(accountId: number, currency: string): ForeignDebtPayment[] {
  if (isHomeCurrency(currency)) throw new Error("foreignDebtPaymentsForAccount: pesos are not a foreign debt");
  const out: ForeignDebtPayment[] = [];
  const code = currency.toUpperCase();
  for (const r of stmtDivisasPayments.all(accountId, currency) as {
    id: number;
    date_iso: string;
    clp: number;
    amount: number | null;
  }[]) {
    if (!(r.clp > 0) || r.amount == null || !(r.amount > 0)) {
      throw new Error(`pago_tarjeta movement ${r.id}: a ${code} payment needs positive pesos and ${code}`);
    }
    out.push({ date_iso: r.date_iso, clp: r.clp, amount: r.amount });
  }
  const cashPayments = stmtForeignCashPayments.all(accountId, currency) as {
    id: number;
    from_account_id: number | null;
    date_iso: string;
    amount: number;
  }[];
  if (cashPayments.length > 0) {
    const costs = foreignOutflowPesoCostByMovement();
    const scale = 10 ** currencyMinorDigits(currency);
    for (const r of cashPayments) {
      if (r.from_account_id == null || !isForeignCashAccountIn(r.from_account_id, currency)) {
        throw new Error(`pago_tarjeta movement ${r.id}: a payment in ${code} must leave a ${code} cash account`);
      }
      const cost = costs.get(r.id);
      if (!cost) throw new Error(`pago_tarjeta movement ${r.id}: the ${code} cost tracer did not price it`);
      if (cost.currency !== currency || Math.round(cost.amount * scale) !== Math.round(r.amount * scale) || !(r.amount > 0)) {
        throw new Error(`pago_tarjeta movement ${r.id}: priced ${cost.amount} ${cost.currency.toUpperCase()} for a ${code} ${r.amount} payment`);
      }
      out.push({ date_iso: r.date_iso, clp: cost.clp, amount: r.amount });
    }
  }
  for (const r of traspasoForeignLegs(accountId, currency)) {
    const date_iso = parseDdMmYyToIso(String(r.transaction_date ?? ""));
    if (!date_iso) {
      throw new Error(`traspaso link ${r.link_id}: unparsable ${code} line date ${JSON.stringify(r.transaction_date)}`);
    }
    out.push({ date_iso, clp: r.clp, amount: r.amount });
  }
  return out;
}

/** A card line that pays its debt in a foreign currency, with its amount in that currency. */
export type CcForeignPaymentLine = { statement_line_id: number; date_iso: string | null; amount: number };

/**
 * The pesos a foreign payment line in `currency` (`isCcForeignPaymentLine` in `ccForeignStatementBilled.ts`)
 * shows: what was actually paid for it. It is printed on the statement after the facturación it pays, so the rate of the facturación
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
export function foreignPaymentLineClpResolver(
  accountId: number,
  currency: string,
  facturaciones: readonly FacturacionWindowRow[],
  facturacionRate: (billingMonth: string) => number
): (line: CcForeignPaymentLine) => number {
  const divisasByKey = new Map<string, CcPaymentPairing>();
  for (const p of listCcPaymentPairings(accountId)) {
    if (p.currency === currency) divisasByKey.set(p.key, p);
  }
  const divisasByLine = new Map<number, CcPaymentPairing>();
  for (const r of listCcPaymentEvidenceRows(accountId)) {
    const paired = r.currency === currency ? divisasByKey.get(r.key) : undefined;
    if (paired) divisasByLine.set(r.id, paired);
  }
  const traspasoClpByLine = ccTraspasoLinkedClpByForeignLineId(accountId, currency);
  const sorted = sortedByDistinctClose(facturaciones);
  return (line) => {
    const divisas = divisasByLine.get(line.statement_line_id);
    if (divisas) return -divisas.amount_clp;
    const traspasoClp = traspasoClpByLine.get(line.statement_line_id);
    if (traspasoClp != null) return -traspasoClp;
    if (!line.date_iso) {
      throw new Error(`Account ${accountId}: ${currency.toUpperCase()} payment line ${line.statement_line_id} has no date`);
    }
    const paid = facturacionPaidOn(sorted, line.date_iso);
    if (!paid) {
      throw new Error(
        `Account ${accountId}: ${currency.toUpperCase()} payment line ${line.statement_line_id} (${line.date_iso}) precedes every facturación close — no facturación it paid`
      );
    }
    return Math.round(line.amount * facturacionRate(paid.billing_month));
  };
}

/**
 * The foreign currencies a card bills in: its issuer's statement currencies other than pesos and
 * every currency its own statements carry — the currencies its facturaciones need a rate for.
 * Sorted, dollars first (the card table's order).
 */
export function cardForeignCurrencies(accountId: number): string[] {
  const { primary, secondary } = ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.statement_currencies;
  const set = new Set<string>([primary, ...secondary]);
  for (const r of stmtStatementCurrencies.all(accountId) as { currency: string }[]) set.add(r.currency);
  set.delete("clp");
  return [...set].sort((a, b) => (a === "usd" ? -1 : b === "usd" ? 1 : a.localeCompare(b)));
}

const stmtStatementCurrencies = db.prepare(`SELECT DISTINCT currency FROM cc_statements WHERE account_id = ?`);

/** Whether the card ever billed in `currency` — only then do its facturaciones need a rate for it. */
export function accountHasStatementsIn(accountId: number, currency: string): boolean {
  return stmtHasStatementIn.get(accountId, currency) != null;
}

const stmtHasStatementIn = db.prepare(`SELECT 1 FROM cc_statements WHERE account_id = ? AND currency = ? LIMIT 1`);

/** {@link facturacionForeignRates} over the account's own payments in `currency`, at `now`'s Chile date. */
export function facturacionForeignRatesForAccount(
  accountId: number,
  currency: string,
  facturaciones: readonly FacturacionWindowRow[],
  now: Date = new Date()
): Map<string, FacturacionForeignRate> {
  const todayYmd = chileWallClockAt(now).ymd;
  const code = currency.toUpperCase();
  return facturacionForeignRates(facturaciones, foreignDebtPaymentsForAccount(accountId, currency), {
    todayYmd,
    payByRate: (payByIso) => {
      const rate =
        currency === "usd" // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3
          ? fxMonthEndForBalanceUsd(payByFxDateIso(payByIso))?.clp_per_usd
          : convertCurrency(1, currency, "clp", payByFxDateIso(payByIso), { side: "debt" });
      if (rate == null || !(rate > 0)) {
        throw new Error(`Account ${accountId}: no ${code}/CLP rate on or before ${payByFxDateIso(payByIso)}`);
      }
      return rate;
    },
    liveRate: () => {
      const rate =
        currency === "usd" // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3
          ? fxForLiveMtm(todayYmd, now)?.clp_per_usd
          : convertCurrency(1, currency, "clp", todayYmd, { side: "debt" });
      if (rate == null || !(rate > 0)) {
        throw new Error(`Account ${accountId}: no ${code}/CLP rate for ${todayYmd}`);
      }
      return rate;
    },
  });
}
