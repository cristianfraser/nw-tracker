/**
 * Estimates, from the ledger, of the F22 codes third parties report in March (DJ 1894 fund
 * redemptions, DJ 1898 / Certificado N°20 mortgage interest) — used by the draft only for a year
 * with neither a filed form nor informed DJs (the open year, or one never filed). Amounts are
 * «actualizados» to December with the SII year-end factor of their month (one decimal, ≥ 0).
 *
 * Fund redemptions (codes 155 / 1869, losses 169): the Fintual goals outside APV
 * (`fund_series_key` fintual_cert_*, not apv_*), FIFO as Fintual computes it, each lot's cost
 * reajustado by the official IPC from the month before the purchase to the month before the
 * redemption. Checked against DJ 1894 for 2025: redemptions 74.050.000 = the 52.450.000 redeemed +
 * 21.600.000 reinvested Fintual reported; gain 8.775.435 vs 8.700.462 reported (0,9%).
 *
 * Mortgage interest (codes 750 / 751): every `depto_payments` mortgage row's interest, prepayments
 * included (interest effectively paid). 2025: 4.892.161 vs 4.799.108 reported by the lender (+1,9%).
 */
import { db } from "./db.js";
import { monthBeforeYmd } from "./foreignShareTaxGains.js";
import { latestOfficialIpcMonth, loadOfficialIpcLookup, officialIpcVariationPctWithStandIn } from "./siiOfficialIpc.js";
import { realizeTaxLots, type TaxLotEvent } from "./taxLots.js";

type Pct = (fromMonth: string, toMonth: string) => number;

function yearEndPct(): { pct: Pct; toMonth: (incomeYear: number) => string } {
  const latest = latestOfficialIpcMonth();
  const ipcBetween = officialIpcVariationPctWithStandIn(loadOfficialIpcLookup(), latest);
  const pct: Pct = (a, b) => (a >= b ? 0 : Math.max(0, Math.round(ipcBetween(a, b) * 10) / 10));
  return { pct, toMonth: (y) => (latest < `${y}-11-01` ? latest : `${y}-11-01`) };
}

/** A fund account's deposits and redemptions as lot events (units = cuotas, amounts in pesos). */
export function fundTaxLotEvents(accountId: number): TaxLotEvent[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, to_account_id, amount, units_delta FROM movements
        WHERE ? IN (account_id, from_account_id, to_account_id)`
    )
    .all(accountId) as {
    id: number;
    occurred_on: string;
    account_id: number | null;
    to_account_id: number | null;
    amount: number;
    units_delta: number | null;
  }[];
  const events: TaxLotEvent[] = rows.map((r) => {
    if (r.units_delta == null || r.units_delta === 0) {
      throw new Error(`Fund lots: account ${accountId} movement ${r.id} has no cuotas`);
    }
    const inflow = r.to_account_id === accountId || (r.account_id === accountId && r.units_delta > 0);
    const units = Math.abs(r.units_delta);
    return inflow
      ? { kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost: Math.abs(r.amount) }
      : { kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: Math.abs(r.amount) };
  });
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  return events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
}

export type FundRedemptionEstimate = { redemptionsClp: number; gainClp: number; lossClp: number };

export function fundRedemptionGainsForYear(incomeYear: number): FundRedemptionEstimate {
  const { pct, toMonth } = yearEndPct();
  const accounts = db
    .prepare(
      `SELECT id FROM accounts WHERE fund_series_key LIKE 'fintual_cert_%' AND fund_series_key NOT LIKE 'fintual_cert_apv%'`
    )
    .all() as { id: number }[];
  let redemptions = 0;
  let gain = 0;
  let loss = 0;
  for (const a of accounts) {
    for (const d of realizeTaxLots(fundTaxLotEvents(a.id), "fifo").disposals) {
      if (!d.date.startsWith(`${incomeYear}-`)) continue;
      const cost = d.slices.reduce((s, x) => s + x.cost * (1 + pct(monthBeforeYmd(x.acquiredOn), monthBeforeYmd(d.date)) / 100), 0);
      const result = (d.proceeds - cost) * (1 + pct(monthBeforeYmd(d.date), toMonth(incomeYear)) / 100);
      redemptions += d.proceeds;
      if (result >= 0) gain += result;
      else loss -= result;
    }
  }
  return { redemptionsClp: Math.round(redemptions), gainClp: Math.round(gain), lossClp: Math.round(loss) };
}

export function mortgageInterestForYear(incomeYear: number): number {
  const { pct, toMonth } = yearEndPct();
  const rows = db
    .prepare(
      `SELECT m.occurred_on, p.interes_clp FROM depto_payments p JOIN movements m ON m.id = p.movement_id
        WHERE p.kind = 'mortgage' AND p.interes_clp IS NOT NULL AND m.occurred_on LIKE ?`
    )
    .all(`${incomeYear}-%`) as { occurred_on: string; interes_clp: number }[];
  return Math.round(
    rows.reduce((s, r) => s + r.interes_clp * (1 + pct(monthBeforeYmd(r.occurred_on), toMonth(incomeYear)) / 100), 0)
  );
}

/** Art. 55 bis: the lesser of the interest and 8 UTA, reduced proportionally between 90 and 150 UTA of gross income. */
export function mortgageInterestDeduction(interestClp: number, grossIncomeClp: number, utaClp: number): number {
  const capped = Math.min(interestClp, 8 * utaClp);
  const rbaUta = grossIncomeClp / utaClp;
  if (rbaUta <= 90) return Math.round(capped);
  if (rbaUta > 150) return 0;
  return Math.round((capped * (250 - 1.667 * rbaUta)) / 100);
}
