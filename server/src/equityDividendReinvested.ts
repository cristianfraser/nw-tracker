/**
 * Dividend USD reinvested (DRIP) — counts toward cost basis, not pocket deposits.
 */

import type { DepositInflowEvent } from "./accountDeposits.js";
import {
  totalDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
} from "./accountDeposits.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

type DividendMovRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_usd: number;
};

function loadDividendUsdRows(accountIds: number[]): DividendMovRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, account_id, occurred_on, amount_usd
       FROM movements
       WHERE account_id IN (${ph})
         AND flow_kind = 'dividend_usd'
         AND amount_usd IS NOT NULL
         AND amount_usd != 0
       ORDER BY account_id, occurred_on, id`
    )
    .all(...accountIds) as DividendMovRow[];
}

export function loadDividendReinvestedSortFlows(
  accountIds: number[]
): Map<number, { occurred_on: string; amt: number; tie: string }[]> {
  const ids = [...new Set(accountIds.filter((id) => id > 0 && accountUsesEquityMtm(id)))];
  const out = new Map<number, { occurred_on: string; amt: number; tie: string }[]>();
  if (ids.length === 0) return out;

  for (const row of loadDividendUsdRows(ids)) {
    const clp = usdToClpReferenceRounded(row.amount_usd, row.occurred_on);
    if (clp == null || !Number.isFinite(clp) || clp === 0) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push({
      occurred_on: row.occurred_on,
      amt: clp,
      tie: `d:${row.id}`,
    });
  }
  return out;
}

export function loadDividendReinvestedInflowEvents(
  accountIds: number[]
): Map<number, DepositInflowEvent[]> {
  const map = loadDividendReinvestedSortFlows(accountIds);
  const out = new Map<number, DepositInflowEvent[]>();
  for (const [id, flows] of map) {
    const sorted = [...flows].sort(
      (a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.tie.localeCompare(b.tie)
    );
    out.set(
      id,
      sorted.map(({ occurred_on, amt }) => ({ occurred_on, amt }))
    );
  }
  return out;
}

export function getDividendReinvestedInflowEventsForAccount(accountId: number): DepositInflowEvent[] {
  if (!Number.isFinite(accountId) || accountId <= 0) return [];
  return loadDividendReinvestedInflowEvents([accountId]).get(accountId) ?? [];
}

export function totalDividendsReinvestedClpForAccount(accountId: number): number {
  return getDividendReinvestedInflowEventsForAccount(accountId).reduce((s, e) => s + e.amt, 0);
}

export function equityCostBasisClpForAccount(accountId: number, depositedClp: number): number {
  if (!accountUsesEquityMtm(accountId)) return depositedClp;
  return depositedClp + totalDividendsReinvestedClpForAccount(accountId);
}

export type EquityReturnSnapshot = {
  dividends_reinvested_clp: number;
  cost_basis_clp: number;
  total_return_clp: number | null;
  return_on_deposited_pct: number | null;
  naive_gain_clp: number | null;
};

export function equityReturnSnapshot(
  accountId: number,
  depositedClp: number,
  valueClp: number | null
): EquityReturnSnapshot | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const dividends_reinvested_clp = totalDividendsReinvestedClpForAccount(accountId);
  const cost_basis_clp = depositedClp + dividends_reinvested_clp;
  const total_return_clp =
    valueClp != null && Number.isFinite(valueClp) ? valueClp - cost_basis_clp : null;
  const naive_gain_clp =
    valueClp != null && Number.isFinite(valueClp) ? valueClp - depositedClp : null;
  const return_on_deposited_pct =
    total_return_clp != null &&
    depositedClp > 0 &&
    Number.isFinite(total_return_clp / depositedClp)
      ? total_return_clp / depositedClp
      : null;
  return {
    dividends_reinvested_clp,
    cost_basis_clp,
    total_return_clp,
    return_on_deposited_pct,
    naive_gain_clp,
  };
}

export function pocketDepositsClpForAccount(accountId: number): number {
  if (accountUsesEquityMtm(accountId)) {
    return totalDisplayDepositsClpForAccount(accountId);
  }
  return totalDepositsClpForAccount(accountId);
}
