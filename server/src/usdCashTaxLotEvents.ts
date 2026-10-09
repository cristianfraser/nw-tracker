/**
 * The dollars on the client's USD cash accounts (Racional USD, Fintual USD, Santander USD) as tax
 * lots, for the exchange result the SII taxes on foreign currency a persona natural buys with
 * pesos. Units are dollars; costs and proceeds are pesos at the dólar observado of the day
 * (Oficio 233/2018, 2573/2022: «tipo de cambio observado … correspondiente al día de la compra y
 * de la venta»; FIFO or LIFO, never average — Oficio 233/2018). One FIFO queue per account; an
 * own transfer between two USD cash accounts moves the exact slices — original purchase date and
 * cost intact — from one queue to the other, and a broker withdrawal request reserves its gross
 * at request time (the walk, `usdCashLotWalk.ts`, shared with the cost tracer).
 *
 * When the result is recognized is the posture, {@link UsdFxPosture}:
 * - `oficio_2573` — using dollars to buy an instrument is selling them (Oficio 2573/2022, reiterated
 *   by 1151 and 1230 of 2023): every `stock_buy` realizes the difference between the observado of
 *   the day the dollars were bought and of the day they were used;
 * - `oficio_2390` — the result exists only when the dollars are converted back to pesos or paid
 *   to a third party (Oficio 2390/2021): a `stock_buy` takes the dollars out of the account
 *   without a result;
 * - `none` — no exchange result except on a reconversion to pesos (for comparison only).
 *
 * Event rules (anything else throws, naming the movement):
 * - a purchase (a CLP → USD transfer) acquires at the observado × dollars (`purchaseCost:
 *   "observado"`, the oficio's rule) or at the pesos paid (`"pesos_paid"`); a dividend, a sale's
 *   proceeds, interest (`savings_earnings`), a plain deposit or any other dollar inflow from a
 *   non-USD-cash account acquires at the observado of its day;
 * - `stock_buy` disposes at the observado: realized under 2573, deferred under 2390 and none;
 * - `pago_tarjeta` and any other dollar outflow to a non-USD-cash account disposes at the
 *   observado: realized under 2573 and 2390, deferred under none;
 * - a reconversion to pesos (a USD from-leg with a CLP counter leg) disposes at the observado,
 *   realized unless none;
 * - a `cash_fee` single-leg row disposes at ZERO proceeds, tagged `fee`: the dollars are lost and
 *   their cost is not a deductible loss (SII FAQ citing Oficio 1474/2020; Oficio 2208/2022) —
 *   reported, excluded from the year's result, and never capitalized into the delivered dollars
 *   (a booked withdrawal's net slices keep only their own pesos, `feeCostToNet: false`);
 * - an own transfer between two USD cash accounts carries slices and is no disposal.
 */
import { db } from "./db.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import { isMovementTransferRow, isUsdCashAccount } from "./movementTransfer.js";
import type { TaxLotDisposal, TaxLotSlice } from "./taxLots.js";
import {
  loadUsdWalkRequests,
  loadUsdWalkRows,
  walkUsdCashLots,
  type UsdLotSlice,
  type UsdWalkOutflow,
  type UsdWalkRequest,
  type UsdWalkRow,
} from "./usdCashLotWalk.js";

export type UsdFxPosture = "oficio_2573" | "oficio_2390" | "none";
export type UsdPurchaseCost = "observado" | "pesos_paid";

export type UsdFxDisposalTag = "realized" | "deferred" | "fee";
export type UsdFxDisposal = TaxLotDisposal & { accountId: number; tag: UsdFxDisposalTag };

export type UsdCashTaxDisposals = { disposals: UsdFxDisposal[]; openLots: (TaxLotSlice & { accountId: number })[] };

/** Days the dólar observado may lag a date (weekends and holidays carry the last published value). */
export const OBSERVADO_MAX_CARRY_DAYS = 7;

/** The dólar observado in force on `ymd` (the last one published on or before it); throws past the carry limit. */
export function observadoOnOrBefore(ymd: string): number {
  const r = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily_bcentral WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(ymd) as { date: string; clp_per_usd: number } | undefined;
  if (!r) throw new Error(`No dólar observado on or before ${ymd}`);
  const gapDays = (Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${r.date}T00:00:00Z`)) / 86_400_000;
  if (gapDays > OBSERVADO_MAX_CARRY_DAYS) {
    throw new Error(`Dólar observado for ${ymd}: the latest is ${r.date}, ${gapDays} days earlier — sync sbif_usd`);
  }
  return r.clp_per_usd;
}

function taxSlice(s: UsdLotSlice): TaxLotSlice {
  return { acquiredOn: s.acquiredOn, acquireMovementId: s.acquireMovementId, units: s.cents / 100, cost: s.clp };
}

/** How an outflow counts: proceeds per dollar (null = zero proceeds) and its tag; null for an own transfer. */
function classifyOutflow(o: UsdWalkOutflow, scope: ReadonlySet<number>, posture: UsdFxPosture): UsdFxDisposalTag | null {
  if (o.carriedTo != null) return null;
  const row = o.row;
  const transfer = isMovementTransferRow(row);
  if (transfer && row.flow_kind === "stock_buy") return posture === "oficio_2573" ? "realized" : "deferred";
  if (transfer && row.currency === "usd" && row.counter_currency === "clp") return posture === "none" ? "deferred" : "realized";
  if (transfer && row.to_account_id != null && !scope.has(row.to_account_id) && row.counter_currency == null) {
    return posture === "none" ? "deferred" : "realized";
  }
  if (!transfer && row.account_id === o.accountId && row.flow_kind === "cash_fee") return "fee";
  throw new Error(
    `USD lots: account ${o.accountId} movement ${row.id} (${row.flow_kind ?? "no flow kind"}) is not a known way dollars leave`
  );
}

/**
 * Pure: the disposals and open slices of every account in `scope` from synthetic or loaded rows.
 * `observadoOn` is the observado in force on a day.
 */
export function usdCashTaxDisposalsFromRows(input: {
  scope: ReadonlySet<number>;
  rows: readonly UsdWalkRow[];
  requests: readonly UsdWalkRequest[];
  eventTimes: ReadonlyMap<number, number>;
  posture: UsdFxPosture;
  purchaseCost: UsdPurchaseCost;
  observadoOn: (ymd: string) => number;
}): UsdCashTaxDisposals {
  const { scope, posture, purchaseCost, observadoOn } = input;
  const walk = walkUsdCashLots({
    scope,
    rows: input.rows,
    requests: input.requests,
    eventTimes: input.eventTimes,
    // The fee's dollars keep their own cost: lost, never capitalized into the delivered dollars.
    feeCostToNet: false,
    priceInflow: ({ row, accountId, cents, source }) => {
      if (source === "purchase") {
        if (row.flow_kind !== "compra_usd_venta_clp" || row.counter_amount == null) {
          throw new Error(`USD lots: account ${accountId} movement ${row.id} (${row.flow_kind ?? "no flow kind"}) is not a known dollar purchase`);
        }
        return purchaseCost === "pesos_paid" ? Math.abs(row.amount) : (cents / 100) * observadoOn(row.occurred_on);
      }
      if (isMovementTransferRow(row) && row.from_account_id != null && scope.has(row.from_account_id)) {
        // Dollars from another USD cash account must have left it on the same row (an own transfer).
        throw new Error(`USD lots: account ${accountId} movement ${row.id} brings dollars from account ${row.from_account_id} that never left it`);
      }
      return (cents / 100) * observadoOn(row.occurred_on);
    },
  });
  if (walk.skippedRows.length > 0) {
    const r = walk.skippedRows[0]!;
    throw new Error(
      `USD lots: movement ${r.id} (${r.flow_kind ?? "no flow kind"}, ${r.currency}) touches a USD cash account but moves no dollars on it`
    );
  }
  const disposals: UsdFxDisposal[] = [];
  for (const o of walk.outflows) {
    const tag = classifyOutflow(o, scope, posture);
    if (tag == null) continue;
    const units = o.cents / 100;
    const proceeds = tag === "fee" ? 0 : units * observadoOn(o.row.occurred_on);
    const slices = o.slices.map(taxSlice);
    const cost = slices.reduce((s, x) => s + x.cost, 0);
    disposals.push({
      date: o.row.occurred_on,
      movementId: o.row.id,
      accountId: o.accountId,
      units,
      proceeds,
      cost,
      gain: proceeds - cost,
      slices,
      tag,
    });
  }
  disposals.sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId);
  const openLots: (TaxLotSlice & { accountId: number })[] = [];
  for (const accountId of [...walk.queues.keys()].sort((a, b) => a - b)) {
    for (const s of walk.queues.get(accountId)!) openLots.push({ ...taxSlice(s), accountId });
  }
  return { disposals, openLots };
}

/** Every USD cash account (`isUsdCashAccount`), by id. */
export function listUsdCashAccountIds(): number[] {
  const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
  return rows.map((r) => r.id).filter((id) => isUsdCashAccount(id));
}

/** The disposals and open slices over every USD cash account, from the DB. */
export function usdCashTaxDisposals(opts: { posture: UsdFxPosture; purchaseCost: UsdPurchaseCost }): UsdCashTaxDisposals {
  const scope = new Set(listUsdCashAccountIds());
  return usdCashTaxDisposalsFromRows({
    scope,
    rows: loadUsdWalkRows(scope),
    requests: loadUsdWalkRequests(scope),
    eventTimes: movementEventTimesMs(),
    posture: opts.posture,
    purchaseCost: opts.purchaseCost,
    observadoOn: observadoOnOrBefore,
  });
}
