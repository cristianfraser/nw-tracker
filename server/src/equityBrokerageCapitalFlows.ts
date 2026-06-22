/**
 * Equity MTM stock accounts: capital flows from USD→stock `stock_buy` transfers
 * (post USD-cash migration). CLP equivalents at payment date feed chart aportes + P/L.
 */

import type { DepositInflowEvent } from "./accountDeposits.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { usdToClpAtPaymentRounded } from "./fxRates.js";

const DRIP_USD_TOLERANCE = 0.02;
const DRIP_MAX_DAYS_AFTER_DIVIDEND = 45;

export type EquityCapitalSortFlow = { occurred_on: string; amt: number; tie: string };

type TransferCapitalRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_usd: number;
  flow_kind: string;
};

type DividendRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_usd: number;
};

function equityMtmAccountIds(accountIds: number[]): number[] {
  return [...new Set(accountIds.filter((id) => id > 0 && accountUsesEquityMtm(id)))];
}

function loadStockBuyCapitalRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.to_account_id AS account_id, m.occurred_on, m.amount_usd, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.to_account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND m.amount_usd IS NOT NULL
         AND m.amount_usd != 0
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.occurred_on, m.amount_usd, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND m.amount_usd IS NOT NULL
         AND m.amount_usd != 0
       ORDER BY occurred_on, id`
    )
    .all(...accountIds, ...accountIds) as TransferCapitalRow[];
}

function loadStockSellCapitalRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.from_account_id AS account_id, m.occurred_on, m.amount_usd, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND m.amount_usd IS NOT NULL
         AND m.amount_usd != 0
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.occurred_on, m.amount_usd, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND m.amount_usd IS NOT NULL
         AND m.amount_usd != 0
       ORDER BY occurred_on, id`
    )
    .all(...accountIds, ...accountIds) as TransferCapitalRow[];
}

function loadDividendUsdRows(accountIds: number[]): DividendRow[] {
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
       ORDER BY occurred_on, id`
    )
    .all(...accountIds) as DividendRow[];
}

function transferRowToSortFlow(row: TransferCapitalRow, sign: 1 | -1): EquityCapitalSortFlow | null {
  const clp = usdToClpAtPaymentRounded(row.amount_usd, row.occurred_on);
  if (clp == null || !Number.isFinite(clp) || clp === 0) return null;
  return {
    occurred_on: row.occurred_on,
    amt: sign * clp,
    tie: `t:${row.id}`,
  };
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T12:00:00Z`);
  const b = Date.parse(`${toYmd}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/**
 * USD from a stock_buy attributable to a prior dividend_usd (full DRIP or manual top-up + div).
 * Returns 0 when the buy is entirely pocket capital.
 */
function dripUsdAttributedToBuy(
  buyUsd: number,
  buyOccurredOn: string,
  dividends: DividendRow[] | undefined,
  consumed: Set<number>
): number {
  if (!dividends?.length) return 0;
  const buyMag = Math.abs(buyUsd);
  for (const d of dividends) {
    if (consumed.has(d.id)) continue;
    const divMag = Math.abs(d.amount_usd);
    const days = daysBetweenYmd(d.occurred_on, buyOccurredOn);
    if (days < 0 || days > DRIP_MAX_DAYS_AFTER_DIVIDEND) continue;
    if (Math.abs(buyMag - divMag) <= DRIP_USD_TOLERANCE) {
      consumed.add(d.id);
      return buyMag;
    }
    if (buyMag > divMag + DRIP_USD_TOLERANCE) {
      consumed.add(d.id);
      return divMag;
    }
  }
  return 0;
}

/**
 * Capital in/out from stock_buy / stock_sell transfers, CLP at payment FX.
 * When `personalOnly`, excludes DRIP reinvestment stock_buys matched to dividend_usd same month.
 */
export function loadEquityBrokerageCapitalSortFlows(
  accountIds: number[],
  personalOnly: boolean
): Map<number, EquityCapitalSortFlow[]> {
  const mtmIds = equityMtmAccountIds(accountIds);
  const out = new Map<number, EquityCapitalSortFlow[]>();
  if (mtmIds.length === 0) return out;

  const buys = loadStockBuyCapitalRows(mtmIds);
  const sells = loadStockSellCapitalRows(mtmIds);
  const dividendsByAccount = personalOnly
    ? (() => {
        const m = new Map<number, DividendRow[]>();
        for (const d of loadDividendUsdRows(mtmIds)) {
          if (!m.has(d.account_id)) m.set(d.account_id, []);
          m.get(d.account_id)!.push(d);
        }
        for (const list of m.values()) {
          list.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id - b.id);
        }
        return m;
      })()
    : null;
  const consumedDividends = new Map<number, Set<number>>();

  for (const row of buys) {
    let amt: number | null = null;
    if (personalOnly && dividendsByAccount) {
      const divs = dividendsByAccount.get(row.account_id);
      if (!consumedDividends.has(row.account_id)) consumedDividends.set(row.account_id, new Set());
      const dripUsd = dripUsdAttributedToBuy(
        row.amount_usd,
        row.occurred_on,
        divs,
        consumedDividends.get(row.account_id)!
      );
      if (dripUsd > 0) {
        const pocketUsd = Math.abs(row.amount_usd) - dripUsd;
        if (pocketUsd <= DRIP_USD_TOLERANCE) continue;
        amt = usdToClpAtPaymentRounded(pocketUsd, row.occurred_on);
      }
    }
    if (amt == null) {
      const flow = transferRowToSortFlow(row, 1);
      if (!flow) continue;
      amt = flow.amt;
    }
    if (amt === 0 || !Number.isFinite(amt)) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push({
      occurred_on: row.occurred_on,
      amt,
      tie: `t:${row.id}`,
    });
  }

  for (const row of sells) {
    const flow = transferRowToSortFlow(row, -1);
    if (!flow) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push(flow);
  }

  return out;
}

export function loadEquityBrokerageCapitalInflowEvents(
  accountIds: number[],
  personalOnly: boolean
): Map<number, DepositInflowEvent[]> {
  const map = loadEquityBrokerageCapitalSortFlows(accountIds, personalOnly);
  const out = new Map<number, DepositInflowEvent[]>();
  for (const [id, flows] of map) {
    const sorted = [...flows].sort(
      (a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.tie.localeCompare(b.tie)
    );
    out.set(
      id,
      sorted
        .filter((f) => f.amt !== 0 && Number.isFinite(f.amt))
        .map(({ occurred_on, amt }) => ({ occurred_on, amt }))
    );
  }
  return out;
}
