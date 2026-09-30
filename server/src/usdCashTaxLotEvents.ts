/**
 * The dollars on a USD cash account (Racional USD, Fintual USD) as tax lots, for the exchange
 * result the SII taxes on foreign currency a persona natural buys with pesos. Units are dollars;
 * costs and proceeds are pesos at the dólar observado of the day (Oficio 233/2018, 2573/2022:
 * «tipo de cambio observado … correspondiente al día de la compra y de la venta»; FIFO or LIFO,
 * never average — Oficio 233/2018).
 *
 * When the result is recognized is the posture, {@link UsdFxPosture}:
 * - `oficio_2573` — using dollars to buy an instrument is selling them (Oficio 2573/2022, reiterated
 *   by 1151 and 1230 of 2023): every `stock_buy` realizes the difference between the observado of
 *   the day the dollars were bought and of the day they were used;
 * - `oficio_2390` — the result exists only when dollars are converted back to pesos (Oficio
 *   2390/2021): a `stock_buy` takes the dollars out of the account without a result;
 * - `none` — no exchange result at all (for comparison only).
 * Every disposal carries `tag: "realized"` or `"deferred"`; only the realized ones are income.
 *
 * Dollars that were not bought — a dividend, a sale's proceeds, interest — enter at the observado
 * of the day they arrived. A purchase enters at the observado of its day (`purchaseCost:
 * "observado"`, the oficio's rule) or at the pesos actually paid (`"pesos_paid"`).
 */
import { db } from "./db.js";
import type { TaxLotEvent } from "./taxLots.js";

export type UsdFxPosture = "oficio_2573" | "oficio_2390" | "none";
export type UsdPurchaseCost = "observado" | "pesos_paid";

export type UsdCashTaxLotRow = {
  id: number;
  occurred_on: string;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  flow_kind: string | null;
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
};

/** Days the dólar observado may lag a date (weekends and holidays carry the last published value). */
export const OBSERVADO_MAX_CARRY_DAYS = 7;

export function usdCashTaxLotEventsFromRows(
  accountId: number,
  rows: readonly UsdCashTaxLotRow[],
  opts: { posture: UsdFxPosture; purchaseCost: UsdPurchaseCost; observadoOn: (ymd: string) => number }
): TaxLotEvent[] {
  const { posture, purchaseCost, observadoOn } = opts;
  const events: TaxLotEvent[] = [];
  const usd = (r: UsdCashTaxLotRow) => {
    if (r.currency !== "usd") throw new Error(`USD lots: movement ${r.id} is in ${r.currency}`);
    return r.amount;
  };
  for (const r of rows) {
    const into = r.to_account_id === accountId;
    const outOf = r.from_account_id === accountId;
    const single = r.account_id === accountId;
    const acquire = (units: number, cost: number) =>
      events.push({ kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost });
    if (into && r.flow_kind === "compra_usd_venta_clp") {
      if (r.currency !== "clp" || r.counter_currency !== "usd" || r.counter_amount == null) {
        throw new Error(`USD lots: conversion ${r.id} is not pesos → dollars`);
      }
      const units = r.counter_amount;
      acquire(units, purchaseCost === "observado" ? units * observadoOn(r.occurred_on) : r.amount);
    } else if (into && (r.flow_kind === "dividend_payout" || r.flow_kind === "stock_sell")) {
      const units = usd(r);
      acquire(units, units * observadoOn(r.occurred_on));
    } else if (single && r.flow_kind === "savings_earnings") {
      const units = usd(r);
      acquire(units, units * observadoOn(r.occurred_on));
    } else if (outOf && r.flow_kind === "stock_buy") {
      const units = usd(r);
      events.push({
        kind: "dispose",
        date: r.occurred_on,
        movementId: r.id,
        units,
        proceeds: units * observadoOn(r.occurred_on),
        tag: posture === "oficio_2573" ? "realized" : "deferred",
      });
    } else if (outOf && r.counter_currency === "clp") {
      const units = usd(r);
      events.push({
        kind: "dispose",
        date: r.occurred_on,
        movementId: r.id,
        units,
        proceeds: units * observadoOn(r.occurred_on),
        tag: posture === "none" ? "deferred" : "realized",
      });
    } else {
      throw new Error(
        `USD lots: account ${accountId} movement ${r.id} (${r.flow_kind ?? "no flow kind"}) is not a known way dollars enter or leave`
      );
    }
  }
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  return events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
}

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

export function loadUsdCashTaxLotEvents(
  accountId: number,
  opts: { posture: UsdFxPosture; purchaseCost: UsdPurchaseCost }
): TaxLotEvent[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, from_account_id, to_account_id, flow_kind, amount, currency,
              counter_amount, counter_currency
         FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
    )
    .all(accountId, accountId, accountId) as UsdCashTaxLotRow[];
  return usdCashTaxLotEventsFromRows(accountId, rows, { ...opts, observadoOn: observadoOnOrBefore });
}
