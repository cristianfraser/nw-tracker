/**
 * Equity MTM stock accounts: capital flows from cash→stock `stock_buy` transfers
 * (post USD-cash migration). CLP equivalents at payment date feed chart aportes + P/L.
 * CLP-quoted stocks (Santiago `.SN`) fund from CLP cash: the transfer carries amount_clp
 * (no amount_usd) and counts as a `clp_wire` capital flow at face value.
 *
 * Dividends reduce cost basis: `dividend_payout` is a negative capital flow on the stock;
 * `dividend_usd` (DRIP — the row carries both the dividend and the reinvested units) nets
 * to zero capital and emits nothing.
 */

import type { DepositInflowEvent } from "./accountDeposits.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { db } from "./db.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

const FX_WIRE_USD_TOLERANCE = 0.02;

export type EquityCapitalKind = "clp_wire" | "usd_reference";

export type EquityCapitalSortFlow = {
  occurred_on: string;
  amt: number;
  amt_usd: number | null;
  capital_kind: EquityCapitalKind;
  tie: string;
};

type TransferCapitalRow = {
  id: number;
  account_id: number;
  from_account_id: number | null;
  occurred_on: string;
  amount_usd: number | null;
  amount_clp: number | null;
  flow_kind: string;
};

type ClpWireLeg = { clp: number; usd: number };

function equityMtmAccountIds(accountIds: number[]): number[] {
  return [...new Set(accountIds.filter((id) => id > 0 && accountUsesEquityMtm(id)))];
}

function loadStockBuyCapitalRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.to_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount_usd, m.amount_clp, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.to_account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND ((m.amount_usd IS NOT NULL AND m.amount_usd != 0) OR COALESCE(m.amount_clp, 0) != 0)
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.from_account_id, m.occurred_on, m.amount_usd, m.amount_clp, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND ((m.amount_usd IS NOT NULL AND m.amount_usd != 0) OR COALESCE(m.amount_clp, 0) != 0)
       ORDER BY occurred_on, id`
    )
    .all(...accountIds, ...accountIds) as TransferCapitalRow[];
}

function loadStockSellCapitalRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.from_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount_usd, m.amount_clp, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND ((m.amount_usd IS NOT NULL AND m.amount_usd != 0) OR COALESCE(m.amount_clp, 0) != 0)
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.from_account_id, m.occurred_on, m.amount_usd, m.amount_clp, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND ((m.amount_usd IS NOT NULL AND m.amount_usd != 0) OR COALESCE(m.amount_clp, 0) != 0)
       ORDER BY occurred_on, id`
    )
    .all(...accountIds, ...accountIds) as TransferCapitalRow[];
}

/**
 * Cash dividends paid out to USD cash (`dividend_payout` transfer, stock = `from_account_id`).
 * A negative deposit: steps the stock's aportes / cost-basis line down (units unchanged).
 * If the cash is later re-invested, the `stock_buy` counts +X → −dividend +buy = net zero.
 */
function loadDividendPayoutRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.from_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount_usd, m.amount_clp, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IN (${ph})
         AND m.flow_kind = 'dividend_payout'
         AND m.amount_usd IS NOT NULL
         AND m.amount_usd != 0
       ORDER BY m.occurred_on, m.id`
    )
    .all(...accountIds) as TransferCapitalRow[];
}

/**
 * `dividend_usd` must carry the reinvested units (DRIP) — that's what makes it capital-neutral.
 * A unitless row would be dividend cash this model can't place; record those as `dividend_payout`.
 */
function assertNoUnitlessDividendUsd(accountIds: number[]): void {
  if (accountIds.length === 0) return;
  const ph = accountIds.map(() => "?").join(",");
  const bad = db
    .prepare(
      `SELECT id FROM movements
       WHERE account_id IN (${ph})
         AND flow_kind = 'dividend_usd'
         AND ABS(COALESCE(units_delta, 0)) < 1e-12
       LIMIT 1`
    )
    .get(...accountIds) as { id: number } | undefined;
  if (bad) {
    throw new Error(
      `dividend_usd movement ${bad.id} has no units_delta — a DRIP row must carry the reinvested units; record cash dividends as dividend_payout`
    );
  }
}

function findClpWireForStockBuy(
  stockAccountId: number,
  fromAccountId: number | null,
  occurredOn: string,
  buyUsd: number
): ClpWireLeg | null {
  const usdMag = Math.abs(buyUsd);
  const searchAccounts = new Set<number>();
  if (fromAccountId != null && fromAccountId > 0) searchAccounts.add(fromAccountId);
  searchAccounts.add(stockAccountId);

  const stmt = db.prepare(
    `SELECT amount_clp, amount_usd FROM movements
     WHERE account_id = ?
       AND occurred_on = ?
       AND flow_kind IN ('compra_usd_venta_clp', 'compra_usd')
       AND amount_clp > 0
       AND amount_usd IS NOT NULL
       AND ABS(COALESCE(units_delta, 0)) < 1e-12`
  );

  for (const accId of searchAccounts) {
    const rows = stmt.all(accId, occurredOn) as { amount_clp: number; amount_usd: number }[];
    for (const r of rows) {
      const rowUsd = Math.abs(r.amount_usd);
      if (Math.abs(rowUsd - usdMag) <= FX_WIRE_USD_TOLERANCE) {
        return { clp: Math.abs(r.amount_clp), usd: rowUsd };
      }
    }
  }
  return null;
}

/** CLP-quoted trade: capital = the CLP that actually moved (no fx reference). */
function clpDirectFlow(row: TransferCapitalRow, sign: 1 | -1): EquityCapitalSortFlow | null {
  const clpMag = Math.abs(row.amount_clp ?? 0);
  if (clpMag === 0 || !Number.isFinite(clpMag)) return null;
  return {
    occurred_on: row.occurred_on,
    amt: sign * clpMag,
    amt_usd: null,
    capital_kind: "clp_wire",
    tie: `t:${row.id}`,
  };
}

function usdReferenceFlow(
  row: TransferCapitalRow,
  sign: 1 | -1
): EquityCapitalSortFlow | null {
  if (row.amount_usd == null || row.amount_usd === 0) return null;
  const usdMag = Math.abs(row.amount_usd);
  const refClp = usdToClpReferenceRounded(usdMag, row.occurred_on);
  if (refClp == null || !Number.isFinite(refClp) || refClp === 0) return null;
  return {
    occurred_on: row.occurred_on,
    amt: sign * refClp,
    amt_usd: sign * usdMag,
    capital_kind: "usd_reference",
    tie: `t:${row.id}`,
  };
}

function stockBuyCapitalFlow(row: TransferCapitalRow): EquityCapitalSortFlow | null {
  if (row.amount_usd == null || row.amount_usd === 0) return clpDirectFlow(row, 1);
  const wire = findClpWireForStockBuy(
    row.account_id,
    row.from_account_id,
    row.occurred_on,
    row.amount_usd
  );
  if (wire) {
    return {
      occurred_on: row.occurred_on,
      amt: wire.clp,
      amt_usd: wire.usd,
      capital_kind: "clp_wire",
      tie: `t:${row.id}`,
    };
  }
  return usdReferenceFlow(row, 1);
}

/**
 * Capital in/out from stock_buy / stock_sell transfers plus dividend_payout returns of capital.
 * CLP wire buys use actual `compra_usd*` CLP; USD-only rotation uses reference CLP at mid.
 */
export function loadEquityBrokerageCapitalSortFlows(
  accountIds: number[]
): Map<number, EquityCapitalSortFlow[]> {
  const mtmIds = equityMtmAccountIds(accountIds);
  const out = new Map<number, EquityCapitalSortFlow[]>();
  if (mtmIds.length === 0) return out;
  assertNoUnitlessDividendUsd(mtmIds);

  const buys = loadStockBuyCapitalRows(mtmIds);
  const sells = loadStockSellCapitalRows(mtmIds);

  for (const row of buys) {
    const flow = stockBuyCapitalFlow(row);
    if (!flow || flow.amt === 0 || !Number.isFinite(flow.amt)) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push(flow);
  }

  for (const row of sells) {
    const flow =
      row.amount_usd != null && row.amount_usd !== 0
        ? usdReferenceFlow(row, -1)
        : clpDirectFlow(row, -1);
    if (!flow) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push(flow);
  }

  // Cash dividends: negative deposit → reduce deposited / cost basis at the USD reference rate.
  for (const row of loadDividendPayoutRows(mtmIds)) {
    const flow = usdReferenceFlow(row, -1);
    if (!flow) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, []);
    out.get(row.account_id)!.push(flow);
  }

  return out;
}

export function loadEquityBrokerageCapitalInflowEvents(
  accountIds: number[]
): Map<number, DepositInflowEvent[]> {
  const map = loadEquityBrokerageCapitalSortFlows(accountIds);
  const out = new Map<number, DepositInflowEvent[]>();
  for (const [id, flows] of map) {
    const sorted = [...flows].sort(
      (a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.tie.localeCompare(b.tie)
    );
    out.set(
      id,
      sorted
        .filter((f) => f.amt !== 0 && Number.isFinite(f.amt))
        .map(({ occurred_on, amt, amt_usd, capital_kind }) => ({
          occurred_on,
          amt,
          amt_usd,
          capital_kind,
        }))
    );
  }
  return out;
}
