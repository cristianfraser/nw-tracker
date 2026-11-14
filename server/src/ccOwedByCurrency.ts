import { ymCompare } from "./calendarMonth.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { cardLineNativeAmount } from "./ccExpenseAmountClp.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { installmentRemainderAfterFacturacionClp } from "./ccInstallmentLedgerDb.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { findLines } from "./cards/purchases.js";
import { closeDateForBillingMonth, lastClosedBillingMonthForAccount, lastPdfBillingMonthForAccount } from "./cards/facturacion.js";
import { annulledOwedAtYmd } from "./ccAnnulledPurchasesRead.js";
import { facturacionMonthByStatementDate } from "./cards/facturacionByStatementDate.js";

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
    /** Unbilled cuotas behind `installment_remainder` (the report shows the count). */
    remaining_cuotas: number;
    open_cycle_lines: number;
    total: number;
  };
  /**
   * Each foreign currency the card owes in (dollars always, and every currency its latest closed
   * facturación bills or a later line is in), to the currency's coin: no plans, so no remainder.
   */
  foreign: Record<string, CcForeignOwed>;
};

export type CcForeignOwed = {
  facturado: number;
  open_cycle_lines: number;
  total: number;
};

/** The entry of `currency` (all zeros when the card owes nothing in it). */
export function foreignOwedIn(owed: CcOwedByCurrency, currency: string): CcForeignOwed {
  return owed.foreign[currency] ?? { facturado: 0, open_cycle_lines: 0, total: 0 };
}

export function ccOwedByCurrency(accountId: number, asOfIso: string): CcOwedByCurrency {
  // A card that stopped billing has no facturación after its last statement (its announced next
  // close passes with nothing to bill), so its last statement is its last close.
  const lastClosed = cardStoppedBilling(accountId)
    ? lastPdfBillingMonthForAccount(accountId)
    : lastClosedBillingMonthForAccount(accountId, asOfIso);

  let facturadoClp = 0;
  const facturadoForeign = new Map<string, number>([["usd", 0]]);
  if (lastClosed) {
    const row = billingDetailCacheForAccount(accountId).facturaciones.find(
      (f) => f.billing_month === lastClosed
    );
    if (!row) {
      throw new Error(`Account ${accountId}: no facturación row for the closed month ${lastClosed}`);
    }
    // A currency the facturación never billed carries no figure: nothing owed in it.
    facturadoClp = row.facturado_clp ?? 0;
    for (const f of row.facturado_foreign) facturadoForeign.set(f.currency, f.amount ?? 0);
  }

  // The lines of every later facturación, by the one rule that files a statement's lines under a
  // facturación (a stale bucket's leftovers belong to the open month). Cuota lines stay out: the
  // plans carry them in the remainder. A line is in its own currency (migration 319).
  const monthByDate = facturacionMonthByStatementDate(accountId);
  let linesClp = 0;
  const linesForeign = new Map<string, number>();
  for (const r of findLines({ accountId })) {
    const bm = monthByDate.get(r.statement_date);
    if (!bm) throw new Error(`Account ${accountId}: statement ${r.statement_date} belongs to no facturación`);
    if (lastClosed && ymCompare(bm, lastClosed) <= 0) continue;
    if (r.installment_flag === 1) continue;
    const native = cardLineNativeAmount({ ...r, installment_flag: 0 });
    if (!native) continue;
    if (isHomeCurrency(native.currency)) linesClp += Math.round(native.amount);
    else linesForeign.set(native.currency, (linesForeign.get(native.currency) ?? 0) + native.amount);
  }

  // A purchase the bank annulled before billing it: the bank's cupo held it from its purchase day
  // until it dropped it from the listing (`cc_annulled_purchases`).
  for (const [currency, amount] of annulledOwedAtYmd(accountId, asOfIso)) {
    if (isHomeCurrency(currency)) linesClp += Math.round(amount);
    else linesForeign.set(currency, (linesForeign.get(currency) ?? 0) + amount);
  }

  const remainder = installmentRemainderAfterFacturacionClp(accountId, lastClosed, asOfIso);

  const foreign: Record<string, CcForeignOwed> = {};
  for (const currency of new Set([...facturadoForeign.keys(), ...linesForeign.keys()])) {
    const facturado = facturadoForeign.get(currency) ?? 0;
    const lines = linesForeign.get(currency) ?? 0;
    foreign[currency] = {
      facturado: roundToCurrency(facturado, currency),
      open_cycle_lines: roundToCurrency(lines, currency),
      total: roundToCurrency(facturado + lines, currency),
    };
  }

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
    foreign,
  };
}