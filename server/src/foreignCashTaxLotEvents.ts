/**
 * The foreign currency held on the client's foreign cash accounts (Racional USD, Fintual USD,
 * Santander USD, a euro account) as tax lots, for the exchange result the SII taxes on foreign
 * currency a persona natural buys with pesos. Oficio 2573/2022 states its rule for «moneda
 * extranjera» (the dollar is only its example) and converts «según el tipo de cambio observado de
 * la moneda que se trate, publicado por el Banco Central», so every currency is treated alike:
 * units are amounts of the account's currency; costs and proceeds are pesos at that currency's
 * observado of the day (`bcentralObservado.ts`: the dollar's and the euro's; a currency the Banco
 * Central does not publish throws). FIFO or LIFO, never average — Oficio 233/2018. One FIFO queue
 * per account; an own transfer between two accounts of the same currency moves the exact slices —
 * original purchase date and cost intact — from one queue to the other, and a broker withdrawal
 * request reserves its gross at request time (the walk, `foreignCashLotWalk.ts`, shared with the
 * cost tracer).
 *
 * When the result is recognized is the posture, {@link ForeignFxPosture}:
 * - `oficio_2573` — using foreign currency to buy an instrument is selling it (Oficio 2573/2022,
 *   reiterated by 1151 and 1230 of 2023): every `stock_buy` realizes the difference between the
 *   observado of the day the currency was bought and of the day it was used;
 * - `oficio_2390` — the result exists only when the currency is converted back to pesos or paid
 *   to a third party (Oficio 2390/2021): a `stock_buy` takes it out of the account without a result;
 * - `none` — no exchange result except on a reconversion to pesos (for comparison only).
 *
 * Event rules (anything else throws, naming the movement):
 * - a purchase (a pesos → currency transfer) acquires at the observado × amount (`purchaseCost:
 *   "observado"`, the oficio's rule) or at the pesos paid (`"pesos_paid"`); a dividend, a sale's
 *   proceeds, interest (`savings_earnings`), a plain deposit or any other inflow from an account
 *   outside the scope acquires at the observado of its day;
 * - a conversion between two foreign currencies (a transfer between two foreign cash accounts of
 *   different currencies) disposes of the first at its observado — realized under 2573 and 2390
 *   (the currency is spent on another, the bank selling it is a third party; Oficio 2573's
 *   «utilizarlos»), deferred under none — and acquires the second at ITS observado × amount under
 *   either cost option (no pesos were paid for it);
 * - `stock_buy` disposes at the observado: realized under 2573, deferred under 2390 and none;
 * - `pago_tarjeta` and any other outflow to an account outside the scope disposes at the observado:
 *   realized under 2573 and 2390, deferred under none;
 * - a reconversion to pesos (a from-leg in the currency with a CLP counter leg) disposes at the
 *   observado, realized unless none;
 * - a `cash_fee` single-leg row disposes at ZERO proceeds, tagged `fee`: the money is lost and its
 *   cost is not a deductible loss (SII FAQ citing Oficio 1474/2020; Oficio 2208/2022) — reported,
 *   excluded from the year's result, and never capitalized into the delivered money (a booked
 *   withdrawal's net slices keep only their own pesos, `feeCostToNet: false`);
 * - an own transfer between two accounts of the same currency carries slices and is no disposal.
 */
import { observadoClpOnOrBefore } from "./bcentralObservado.js";
import { listForeignCashAccountIds } from "./cashCurrency.js";
import { isHomeCurrency } from "./displayUnits.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import { isMovementTransferRow } from "./movementTransfer.js";
import type { TaxLotDisposal, TaxLotSlice } from "./taxLots.js";
import {
  foreignCashScope,
  fromMinor,
  loadForeignWalkRequests,
  loadForeignWalkRows,
  walkForeignCashLots,
  type ForeignLotSlice,
  type ForeignWalkOutflow,
  type ForeignWalkRequest,
  type ForeignWalkRow,
} from "./foreignCashLotWalk.js";

export type ForeignFxPosture = "oficio_2573" | "oficio_2390" | "none";
export type ForeignPurchaseCost = "observado" | "pesos_paid";

export type ForeignFxDisposalTag = "realized" | "deferred" | "fee";
export type ForeignFxDisposal = TaxLotDisposal & { accountId: number; currency: string; tag: ForeignFxDisposalTag };

export type ForeignCashOpenLot = TaxLotSlice & { accountId: number; currency: string };

export type ForeignCashTaxDisposals = { disposals: ForeignFxDisposal[]; openLots: ForeignCashOpenLot[] };

/** The observado of a currency in force on a day, in pesos per unit. */
export type ObservadoLookup = (currency: string, ymd: string) => number;

function taxSlice(s: ForeignLotSlice, currency: string): TaxLotSlice {
  return { acquiredOn: s.acquiredOn, acquireMovementId: s.acquireMovementId, units: fromMinor(s.minor, currency), cost: s.clp };
}

/** How an outflow counts: its tag; null for an own transfer. */
function classifyOutflow(o: ForeignWalkOutflow, scope: ReadonlyMap<number, string>, posture: ForeignFxPosture): ForeignFxDisposalTag | null {
  if (o.carriedTo != null) return null;
  const row = o.row;
  const transfer = isMovementTransferRow(row);
  if (o.convertedTo != null) return posture === "none" ? "deferred" : "realized";
  if (transfer && row.flow_kind === "stock_buy") return posture === "oficio_2573" ? "realized" : "deferred";
  if (transfer && row.currency === o.currency && row.counter_currency != null && isHomeCurrency(row.counter_currency)) {
    return posture === "none" ? "deferred" : "realized";
  }
  if (transfer && row.to_account_id != null && !scope.has(row.to_account_id) && row.counter_currency == null) {
    return posture === "none" ? "deferred" : "realized";
  }
  if (!transfer && row.account_id === o.accountId && row.flow_kind === "cash_fee") return "fee";
  // Money spent from the account (a purchase or a bill a bank statement lists: a single-leg
  // debit): used, like a payment to an account outside the scope (Oficio 2573's «utilizarlos»).
  if (!transfer && row.account_id === o.accountId && row.flow_kind === "withdrawal") return posture === "none" ? "deferred" : "realized";
  throw new Error(
    `${o.currency.toUpperCase()} lots: account ${o.accountId} movement ${row.id} (${row.flow_kind ?? "no flow kind"}) ` +
      "is not a known way the currency leaves"
  );
}

/**
 * Pure: the disposals and open slices of every account in `scope` (account → its currency) from
 * synthetic or loaded rows. `observadoOn` is the observado of a currency in force on a day.
 */
export function foreignCashTaxDisposalsFromRows(input: {
  scope: ReadonlyMap<number, string>;
  rows: readonly ForeignWalkRow[];
  requests: readonly ForeignWalkRequest[];
  eventTimes: ReadonlyMap<number, number>;
  posture: ForeignFxPosture;
  purchaseCost: ForeignPurchaseCost;
  observadoOn: ObservadoLookup;
}): ForeignCashTaxDisposals {
  const { scope, posture, purchaseCost, observadoOn } = input;
  const walk = walkForeignCashLots({
    scope,
    rows: input.rows,
    requests: input.requests,
    eventTimes: input.eventTimes,
    // The fee's money keeps its own cost: lost, never capitalized into the delivered money.
    feeCostToNet: false,
    priceInflow: ({ row, accountId, currency, minor, source }) => {
      const amount = fromMinor(minor, currency);
      if (source === "purchase") {
        if (row.flow_kind !== "fx_exchange" || row.counter_amount == null) {
          throw new Error(
            `${currency.toUpperCase()} lots: account ${accountId} movement ${row.id} (${row.flow_kind ?? "no flow kind"}) is not a known purchase`
          );
        }
        return purchaseCost === "pesos_paid" ? Math.abs(row.amount) : amount * observadoOn(currency, row.occurred_on);
      }
      if (source === "conversion") return amount * observadoOn(currency, row.occurred_on);
      if (isMovementTransferRow(row) && row.from_account_id != null && scope.has(row.from_account_id)) {
        // Money from another account in scope must have left it on the same row (an own transfer or a conversion).
        throw new Error(
          `${currency.toUpperCase()} lots: account ${accountId} movement ${row.id} brings money from account ${row.from_account_id} that never left it`
        );
      }
      return amount * observadoOn(currency, row.occurred_on);
    },
  });
  if (walk.skippedRows.length > 0) {
    const r = walk.skippedRows[0]!;
    throw new Error(
      `Foreign-currency lots: movement ${r.id} (${r.flow_kind ?? "no flow kind"}, ${r.currency}) touches a foreign cash account ` +
        "but moves none of its currency"
    );
  }
  const disposals: ForeignFxDisposal[] = [];
  for (const o of walk.outflows) {
    const tag = classifyOutflow(o, scope, posture);
    if (tag == null) continue;
    const units = fromMinor(o.minor, o.currency);
    const proceeds = tag === "fee" ? 0 : units * observadoOn(o.currency, o.row.occurred_on);
    const slices = o.slices.map((s) => taxSlice(s, o.currency));
    const cost = slices.reduce((s, x) => s + x.cost, 0);
    disposals.push({
      date: o.row.occurred_on,
      movementId: o.row.id,
      accountId: o.accountId,
      currency: o.currency,
      units,
      proceeds,
      cost,
      gain: proceeds - cost,
      slices,
      tag,
    });
  }
  disposals.sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId || a.accountId - b.accountId);
  const openLots: ForeignCashOpenLot[] = [];
  for (const accountId of [...walk.queues.keys()].sort((a, b) => a - b)) {
    const currency = scope.get(accountId)!;
    for (const s of walk.queues.get(accountId)!) openLots.push({ ...taxSlice(s, currency), accountId, currency });
  }
  return { disposals, openLots };
}

/** The disposals and open slices over every foreign cash account, from the DB. */
export function foreignCashTaxDisposals(opts: { posture: ForeignFxPosture; purchaseCost: ForeignPurchaseCost }): ForeignCashTaxDisposals {
  const scope = foreignCashScope(listForeignCashAccountIds());
  return foreignCashTaxDisposalsFromRows({
    scope,
    rows: loadForeignWalkRows(scope),
    requests: loadForeignWalkRequests(scope),
    eventTimes: movementEventTimesMs(),
    posture: opts.posture,
    purchaseCost: opts.purchaseCost,
    observadoOn: observadoClpOnOrBefore,
  });
}
