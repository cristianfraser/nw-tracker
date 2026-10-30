/**
 * The mortgage carrying (interés + seguros) of every dividendo linked to the property's deposit
 * (`expense_deposit_links` with a depto cuota). The property deposit records the FULL dividendo
 * and the property's P/L counts the carrying as a loss, while gastos already counts it as an
 * expense; so the flows readers that sit beside gastos — the flows overview, the /flows/deposits
 * page, the /flows P/L page — take it out of the deposit and put it back into the P/L. One list,
 * so the three cannot drift.
 *
 * Read from the line that IS the payment, once per (purchase_key, deposit): a financing projection
 * (`split_only`) re-presents a card-financed dividendo over later months and is skipped, so the
 * carrying lands on the depto payment day in both installment modes.
 */
import { getAggregationCached, invalidateFlowsOverview } from "./aggregationCache.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { hasSplittableMortgageExpenseDepositLink } from "./expenseDepositLinks.js";
import { buildFlowsExpenseLines, listCreditCardMasterAccountIds, type FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { expenseLineGastosAmount, type GastosUnit } from "./flowsExpensesGastos.js";

export type MortgageCarryingEvent = {
  /** The property deposit movement the dividendo is linked to. */
  deposit_movement_id: number;
  /** The depto payment day (the deposit's day). */
  occurred_on: string;
  /** Carrying in the unit (USD: the line's dollars by the carrying share of the payment). */
  amount: number;
};

/** Carrying (interés + seguros) share of a mortgage-linked payment, in the unit. */
export function mortgageLinkCarryingAmount(
  line: FlowCcExpenseLineRow,
  link: { payment_clp: number; carrying_clp: number },
  unit: GastosUnit
): number {
  if (unit === "usd") {
    // Same fx date as the payment line: allocate the line's USD by the carrying CLP share.
    return expenseLineGastosAmount(line, unit) * (link.carrying_clp / link.payment_clp);
  }
  return link.carrying_clp;
}

export function mortgageCarryingEvents(
  lines: readonly FlowCcExpenseLineRow[],
  unit: GastosUnit
): MortgageCarryingEvent[] {
  const seen = new Set<string>();
  const out: MortgageCarryingEvent[] = [];
  for (const ln of lines) {
    const scope = ln.gastos_scope ?? "both";
    if (scope === "split_only" || scope === "excluded") continue;
    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (!hasSplittableMortgageExpenseDepositLink(link)) continue;
    const key = `${ln.purchase_key}|${link.deposit_movement_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!link.depto_occurred_on) {
      throw new Error(`mortgage expense deposit link without depto_occurred_on: ${ln.purchase_key}`);
    }
    out.push({
      deposit_movement_id: link.deposit_movement_id,
      occurred_on: link.depto_occurred_on.slice(0, 10),
      amount: mortgageLinkCarryingAmount(ln, link, unit),
    });
  }
  return out;
}

/** Σ carrying per `keyOf(occurred_on)` (a month or a day). */
export function sumMortgageCarryingBy(
  events: readonly MortgageCarryingEvent[],
  keyOf: (occurredOn: string) => string
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) out.set(keyOf(e.occurred_on), (out.get(keyOf(e.occurred_on)) ?? 0) + e.amount);
  return out;
}

/**
 * The live rates the expense lines priced dollars at: an unpaid facturación whose pay-by is still
 * ahead shows its dollars at today's rate (`usd_rate_source: live`, `ccFacturacionUsdRate.ts`), read
 * from the cards' billing-detail bundles — which a live-quote tick rebuilds.
 */
function liveUsdRatesFingerprint(): string {
  const parts: string[] = [];
  for (const accountId of listCreditCardMasterAccountIds()) {
    for (const row of billingDetailCacheForAccount(accountId).facturaciones) {
      if (row.usd_rate_source === "live") parts.push(`${accountId}:${row.billing_month}:${row.usd_rate_clp}`);
    }
  }
  return parts.join("|");
}

/**
 * The flows-overview inputs survive a live-quote tick (they read no quote) except through the
 * live dollar rate: when the rate the cached lines used is no longer the cards' current one, they
 * are dropped and rebuild. A tick that leaves the rate alone (a stock or coin quote, the fx day
 * closed) keeps them.
 */
export function syncFlowsInputsWithLiveUsdRates(): void {
  const current = liveUsdRatesFingerprint();
  const key = "flows.overview.inputs|live_usd_rates";
  if (getAggregationCached(key, () => current) === current) return;
  invalidateFlowsOverview({ inputs: true });
  getAggregationCached(key, () => current);
}

/**
 * The finalized expense lines (the Expenses page's), cached under the flows overview's inputs
 * prefix (`flows.overview.inputs|`) so the same invalidations drop them (`invalidateFlowsOverview`).
 */
export function cachedFlowsExpenseLines(): FlowCcExpenseLineRow[] {
  syncFlowsInputsWithLiveUsdRates();
  return getAggregationCached("flows.overview.inputs|lines", () => buildFlowsExpenseLines(listCreditCardMasterAccountIds()));
}

/** {@link mortgageCarryingEvents} over the cached expense lines, per unit. */
export function cachedMortgageCarryingEvents(unit: GastosUnit): MortgageCarryingEvent[] {
  syncFlowsInputsWithLiveUsdRates();
  return getAggregationCached(`flows.overview.inputs|carrying|${unit}`, () =>
    mortgageCarryingEvents(cachedFlowsExpenseLines(), unit)
  );
}
