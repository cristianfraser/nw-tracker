import { db } from "./db.js";
import { ymCompare } from "./calendarMonth.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { effectiveCcExpenseLineAmountUsd } from "./ccExpenseAmountClp.js";
import { installmentRemainderAfterFacturacionClp } from "./ccInstallmentLedgerDb.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import {
  closeDateForBillingMonth,
  lastClosedBillingMonthForAccount,
  lastPdfBillingMonthForAccount,
} from "./ccManualBillingMonth.js";
import { facturacionMonthByStatementDate } from "./ccOpenWebPastePdfReconcile.js";

/**
 * What a card owes in each currency, in the frame of the bank's own «cupo utilizado» (Santander's
 * product summary, `cc_bank_cupo_snapshots`): the latest closed facturación's billed total, plus
 * the plan cuotas no close has billed yet (CLP only — plans are pesos), plus every line filed under
 * a later facturación — charges positive, payments and notas negative, so a payment of the closed
 * bill nets it here rather than in the first term.
 *
 * The bank's side of the same identity, verified on the 2026-08-05 and 2026-09-26 feeds:
 * utilizado = SALDO INICIAL (the closed facturación's total) + saldo capital cuotas + the feed's
 * unbilled rows. The app counts each purchase once either way: a cuota purchase of the open cycle
 * is a plan (its feed row imports as an installment overlap) or, while its count is unknown, a
 * tagged line at full principal.
 */
export type CcOwedByCurrency = {
  account_id: number;
  /** Latest facturación the bank closed (statement or provisional); null before the first. */
  last_closed_billing_month: string | null;
  close_iso: string | null;
  clp: {
    facturado: number;
    installment_remainder: number;
    /** Unbilled cuotas behind `installment_remainder` — each may round a peso off the bank's. */
    remaining_cuotas: number;
    open_cycle_lines: number;
    total: number;
  };
  usd: {
    facturado: number;
    open_cycle_lines: number;
    total: number;
  };
};

const linesForAccount = db.prepare(
  `SELECT s.statement_date, s.currency AS statement_currency, l.installment_flag, l.amount_clp,
          l.amount_usd, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ?`
);

/** Two decimals for dollars, integer pesos: the precision both sides state. */
function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ccOwedByCurrency(accountId: number, asOfIso: string): CcOwedByCurrency {
  // A card that stopped billing has no facturación after its last statement (its announced next
  // close passes with nothing to bill), so its last statement is its last close.
  const lastClosed = creditCardBillingDetailInactive(accountId)
    ? lastPdfBillingMonthForAccount(accountId)
    : lastClosedBillingMonthForAccount(accountId, asOfIso);

  let facturadoClp = 0;
  let facturadoUsd = 0;
  if (lastClosed) {
    const row = billingDetailCacheForAccount(accountId).facturaciones.find(
      (f) => f.billing_month === lastClosed
    );
    if (!row) {
      throw new Error(`Account ${accountId}: no facturación row for the closed month ${lastClosed}`);
    }
    // A currency the facturación never billed carries no figure: nothing owed in it.
    facturadoClp = row.facturado_clp ?? 0;
    facturadoUsd = row.facturado_usd ?? 0;
  }

  // The lines of every later facturación, by the one rule that files a statement's lines under a
  // facturación (a stale bucket's leftovers belong to the open month). Cuota lines stay out: the
  // plans carry them in the remainder.
  const monthByDate = facturacionMonthByStatementDate(accountId);
  let linesClp = 0;
  let linesUsd = 0;
  for (const r of linesForAccount.all(accountId) as {
    statement_date: string;
    statement_currency: string | null;
    installment_flag: number;
    amount_clp: number | null;
    amount_usd: number | null;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
  }[]) {
    const bm = monthByDate.get(r.statement_date);
    if (!bm) throw new Error(`Account ${accountId}: statement ${r.statement_date} belongs to no facturación`);
    if (lastClosed && ymCompare(bm, lastClosed) <= 0) continue;
    if (r.installment_flag === 1) continue;
    const usd = effectiveCcExpenseLineAmountUsd(r);
    if (usd != null) linesUsd += usd;
    else linesClp += Math.round(r.amount_clp ?? 0);
  }

  const remainder = installmentRemainderAfterFacturacionClp(accountId, lastClosed, asOfIso);

  return {
    account_id: accountId,
    last_closed_billing_month: lastClosed,
    close_iso: lastClosed ? closeDateForBillingMonth(accountId, lastClosed).close_iso : null,
    clp: {
      facturado: Math.round(facturadoClp),
      installment_remainder: remainder.amount_clp,
      remaining_cuotas: remainder.cuotas,
      open_cycle_lines: linesClp,
      total: Math.round(facturadoClp) + remainder.amount_clp + linesClp,
    },
    usd: {
      facturado: roundUsd(facturadoUsd),
      open_cycle_lines: roundUsd(linesUsd),
      total: roundUsd(facturadoUsd + linesUsd),
    },
  };
}
