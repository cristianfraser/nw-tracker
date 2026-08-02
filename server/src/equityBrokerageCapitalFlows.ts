/**
 * Equity MTM stock accounts: capital flows from cash→stock `stock_buy` transfers
 * (post USD-cash migration). CLP equivalents at payment date feed chart aportes + P/L.
 * CLP-quoted stocks (Santiago `.SN`) fund from CLP cash: the transfer carries amount_clp
 * (no amount_usd) and counts as a `clp_wire` capital flow at face value.
 *
 * A buy funded by a same-day CLP wire SMALLER than the buy (wire + USD already sitting in
 * the cash account, e.g. a received dividend swept into the next purchase) splits into a
 * composite: the wire pesos count at face (`clp_wire`) and only the residual USD uses the
 * reference rate (`usd_reference`). Guarded to the unambiguous one-wire/one-buy case.
 *
 * Dividends reduce cost basis: `dividend_payout` is a negative capital flow on the stock;
 * a reinvestment is a separate `stock_buy` (+X) that nets it out. The retired single-leg
 * `dividend_usd` DRIP kind must not reappear (fail-fast below).
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
 * The single-leg `dividend_usd` DRIP kind was retired 2026-08-02 (every row was split into
 * dividend_payout + stock_buy transfers by repair-drip-dividend-splits.ts). A reappearing
 * row would silently distort units and capital flows, so fail fast instead.
 */
function assertNoDividendUsdRows(accountIds: number[]): void {
  if (accountIds.length === 0) return;
  const ph = accountIds.map(() => "?").join(",");
  const bad = db
    .prepare(
      `SELECT id FROM movements
       WHERE (account_id IN (${ph}) OR from_account_id IN (${ph}) OR to_account_id IN (${ph}))
         AND flow_kind = 'dividend_usd'
       LIMIT 1`
    )
    .get(...accountIds, ...accountIds, ...accountIds) as { id: number } | undefined;
  if (bad) {
    throw new Error(
      `movement ${bad.id} uses the retired dividend_usd kind — record the dividend as a dividend_payout transfer (stock → USD cash) plus a stock_buy for any reinvestment`
    );
  }
}

/**
 * CLP→USD conversion wires on `accountId` dated `occurredOn`: single-leg `compra_usd*`
 * rows plus compra transfer legs ARRIVING at the account (the post-mirror-conversion
 * shape — e.g. checking → USD cash or CLP wallet → USD cash conversions).
 */
function sameDayWireLegs(accountId: number, occurredOn: string): ClpWireLeg[] {
  const rows = db
    .prepare(
      `SELECT amount_clp, amount_usd FROM movements
       WHERE (account_id = ? OR (account_id IS NULL AND to_account_id = ?))
         AND occurred_on = ?
         AND flow_kind IN ('compra_usd_venta_clp', 'compra_usd')
         AND amount_clp > 0
         AND amount_usd IS NOT NULL
         AND ABS(COALESCE(units_delta, 0)) < 1e-12`
    )
    .all(accountId, accountId, occurredOn) as { amount_clp: number; amount_usd: number }[];
  return rows.map((r) => ({ clp: Math.abs(r.amount_clp), usd: Math.abs(r.amount_usd) }));
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

  for (const accId of searchAccounts) {
    for (const wire of sameDayWireLegs(accId, occurredOn)) {
      if (Math.abs(wire.usd - usdMag) <= FX_WIRE_USD_TOLERANCE) return wire;
    }
  }
  return null;
}

/**
 * Buy funded by a same-day wire plus USD already in the cash account (e.g. a dividend
 * received earlier and swept into the next purchase): wire pesos at face + residual at
 * the reference rate. Fires only in the unambiguous case — the buy is a transfer, its
 * cash account has exactly ONE same-day wire, the wire is genuinely smaller than the
 * buy, and it is the only same-day buy from that cash account (a shared wire cannot be
 * attributed without guessing, so ambiguity falls back to the full reference conversion).
 */
function partialWireCompositeFlows(row: TransferCapitalRow): EquityCapitalSortFlow[] | null {
  const fromId = row.from_account_id;
  if (fromId == null || fromId <= 0) return null;
  if (row.amount_usd == null || row.amount_usd === 0) return null;
  const buyUsd = Math.abs(row.amount_usd);

  const wires = sameDayWireLegs(fromId, row.occurred_on);
  if (wires.length !== 1) return null;
  const wire = wires[0]!;
  if (!(wire.usd < buyUsd - FX_WIRE_USD_TOLERANCE)) return null;

  const sameDayBuys = db
    .prepare(
      `SELECT COUNT(*) AS n FROM movements
       WHERE account_id IS NULL
         AND from_account_id = ?
         AND occurred_on = ?
         AND flow_kind = 'stock_buy'
         AND amount_usd IS NOT NULL
         AND amount_usd != 0`
    )
    .get(fromId, row.occurred_on) as { n: number };
  if (sameDayBuys.n !== 1) return null;

  const residUsd = buyUsd - wire.usd;
  const residClp = usdToClpReferenceRounded(residUsd, row.occurred_on);
  if (residClp == null || !Number.isFinite(residClp) || residClp === 0) return null;

  return [
    {
      occurred_on: row.occurred_on,
      amt: wire.clp,
      amt_usd: wire.usd,
      capital_kind: "clp_wire",
      tie: `t:${row.id}:wire`,
    },
    {
      occurred_on: row.occurred_on,
      amt: residClp,
      amt_usd: residUsd,
      capital_kind: "usd_reference",
      tie: `t:${row.id}:resid`,
    },
  ];
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

function stockBuyCapitalFlows(row: TransferCapitalRow): EquityCapitalSortFlow[] {
  if (row.amount_usd == null || row.amount_usd === 0) {
    const flow = clpDirectFlow(row, 1);
    return flow ? [flow] : [];
  }
  const wire = findClpWireForStockBuy(
    row.account_id,
    row.from_account_id,
    row.occurred_on,
    row.amount_usd
  );
  if (wire) {
    return [
      {
        occurred_on: row.occurred_on,
        amt: wire.clp,
        amt_usd: wire.usd,
        capital_kind: "clp_wire",
        tie: `t:${row.id}`,
      },
    ];
  }
  const composite = partialWireCompositeFlows(row);
  if (composite) return composite;
  const flow = usdReferenceFlow(row, 1);
  return flow ? [flow] : [];
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
  assertNoDividendUsdRows(mtmIds);

  const buys = loadStockBuyCapitalRows(mtmIds);
  const sells = loadStockSellCapitalRows(mtmIds);

  for (const row of buys) {
    for (const flow of stockBuyCapitalFlows(row)) {
      if (flow.amt === 0 || !Number.isFinite(flow.amt)) continue;
      if (!out.has(row.account_id)) out.set(row.account_id, []);
      out.get(row.account_id)!.push(flow);
    }
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
