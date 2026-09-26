import { payByFxDateIso } from "./ccBillingBalances.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { fxForLiveMtm } from "./fxLive.js";

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

/**
 * The USD/CLP rate each facturación SHOWS its dollar charges at — its row, the historial bars
 * and its expense lines (the facturación modal), so the lines add up to the row. A dollar debt
 * payment belongs to the facturación whose close it follows: payments after close M and up to
 * close M+1 pay what M billed. Their weighted rate (Σ pesos ÷ Σ dollars) is the facturación's
 * rate; without any, today's rate while the pay-by is still ahead (the pay-by day included),
 * else the pay-by − 1 debt rate. Pure: the payments and rates come in from the caller.
 */
export function facturacionUsdRates(
  facturaciones: readonly FacturacionWindowRow[],
  payments: readonly UsdDebtPayment[],
  opts: { todayYmd: string; payByRate: (payByIso: string) => number; liveRate: () => number }
): Map<string, FacturacionUsdRate> {
  const sorted = [...facturaciones].sort((a, b) => a.close_date_iso.localeCompare(b.close_date_iso));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.close_date_iso === sorted[i - 1]!.close_date_iso) {
      throw new Error(
        `facturaciones ${sorted[i - 1]!.billing_month} and ${sorted[i]!.billing_month} share the close ${sorted[i]!.close_date_iso}`
      );
    }
  }
  let live: number | null = null;
  const out = new Map<string, FacturacionUsdRate>();
  sorted.forEach((f, i) => {
    const next = sorted[i + 1]?.close_date_iso ?? null;
    let clp = 0;
    let usd = 0;
    for (const p of payments) {
      if (p.date_iso > f.close_date_iso && (next == null || p.date_iso <= next)) {
        clp += p.clp;
        usd += p.usd;
      }
    }
    if (usd > 0) {
      out.set(f.billing_month, { clp_per_usd: clp / usd, source: "paid", paid_usd: usd });
    } else if (f.pay_by_iso != null && f.pay_by_iso < opts.todayYmd) {
      out.set(f.billing_month, { clp_per_usd: opts.payByRate(f.pay_by_iso), source: "pay_by", paid_usd: 0 });
    } else {
      live ??= opts.liveRate();
      out.set(f.billing_month, { clp_per_usd: live, source: "live", paid_usd: 0 });
    }
  });
  return out;
}

const stmtDivisasPayments = db.prepare(
  `SELECT id, occurred_on AS date_iso, amount AS clp, counter_amount AS usd
   FROM movements
   WHERE flow_kind = 'pago_tarjeta' AND to_account_id = ?
     AND currency = 'clp' AND counter_currency = 'usd'`
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
 * dollars the card was credited) and the traspasos de deuda (the bank moving the dollar debt to
 * the peso side at its own rate, `cc_traspaso_deuda_links`).
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
