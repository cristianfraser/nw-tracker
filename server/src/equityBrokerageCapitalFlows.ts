/**
 * Equity MTM stock accounts: capital flows from cash→stock `stock_buy` transfers
 * (post USD-cash migration). CLP equivalents at payment date feed chart aportes + P/L.
 * CLP-quoted stocks (Santiago `.SN`) fund from CLP cash: the transfer carries a CLP
 * amount (no USD leg) and counts as a `clp_wire` capital flow at face value.
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
import {
  isUsdCashAccount,
  signedUsdDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";
import { usdCashUsdToClpAt } from "./usdCashAccounts.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  MOVEMENT_CLP_LEG_SQL,
  MOVEMENT_USD_LEG_SQL,
  movementClpLegOrZero,
  movementUsdLeg,
  type MovementAmountFields,
} from "./movementAmounts.js";

const FX_WIRE_USD_TOLERANCE = 0.02;

// Alias-qualified legs for the queries below that alias movements as `m`.
const M_CLP_LEG_SQL =
  "(CASE WHEN m.currency = 'clp' THEN m.amount WHEN m.counter_currency = 'clp' THEN m.counter_amount ELSE 0 END)";
const M_USD_LEG_SQL =
  "(CASE WHEN m.currency = 'usd' THEN m.amount WHEN m.counter_currency = 'usd' THEN m.counter_amount END)";

export type EquityCapitalKind = "clp_wire" | "usd_reference";

export type EquityCapitalSortFlow = {
  occurred_on: string;
  amt: number;
  amt_usd: number | null;
  capital_kind: EquityCapitalKind;
  tie: string;
};

type TransferCapitalRow = MovementAmountFields & {
  id: number;
  account_id: number;
  from_account_id: number | null;
  occurred_on: string;
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
      `SELECT m.id AS id, m.to_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.to_account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND ((${M_USD_LEG_SQL} IS NOT NULL AND ${M_USD_LEG_SQL} != 0) OR COALESCE(${M_CLP_LEG_SQL}, 0) != 0)
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.from_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_buy'
         AND ((${M_USD_LEG_SQL} IS NOT NULL AND ${M_USD_LEG_SQL} != 0) OR COALESCE(${M_CLP_LEG_SQL}, 0) != 0)
       ORDER BY occurred_on, id`
    )
    .all(...accountIds, ...accountIds) as TransferCapitalRow[];
}

function loadStockSellCapitalRows(accountIds: number[]): TransferCapitalRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id AS id, m.from_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND ((${M_USD_LEG_SQL} IS NOT NULL AND ${M_USD_LEG_SQL} != 0) OR COALESCE(${M_CLP_LEG_SQL}, 0) != 0)
       UNION ALL
       SELECT m.id AS id, m.account_id AS account_id, m.from_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.flow_kind
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.flow_kind = 'stock_sell'
         AND ((${M_USD_LEG_SQL} IS NOT NULL AND ${M_USD_LEG_SQL} != 0) OR COALESCE(${M_CLP_LEG_SQL}, 0) != 0)
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
      `SELECT m.id AS id, m.from_account_id AS account_id, m.from_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.flow_kind
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IN (${ph})
         AND m.flow_kind = 'dividend_payout'
         AND ${M_USD_LEG_SQL} IS NOT NULL
         AND ${M_USD_LEG_SQL} != 0
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
      `SELECT ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements
       WHERE (account_id = ? OR (account_id IS NULL AND to_account_id = ?))
         AND occurred_on = ?
         AND flow_kind IN ('compra_usd_venta_clp', 'compra_usd')
         AND ${MOVEMENT_CLP_LEG_SQL} > 0
         AND ${MOVEMENT_USD_LEG_SQL} IS NOT NULL
         AND ABS(COALESCE(units_delta, 0)) < 1e-12`
    )
    .all(accountId, accountId, occurredOn) as MovementAmountFields[];
  return rows.map((r) => ({
    clp: Math.abs(movementClpLegOrZero(r)),
    usd: Math.abs(movementUsdLeg(r) ?? 0),
  }));
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
  const usdLeg = movementUsdLeg(row);
  if (usdLeg == null || usdLeg === 0) return null;
  const buyUsd = Math.abs(usdLeg);

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
         AND ${MOVEMENT_USD_LEG_SQL} IS NOT NULL
         AND ${MOVEMENT_USD_LEG_SQL} != 0`
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
  const clpMag = Math.abs(movementClpLegOrZero(row));
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
  const usdLeg = movementUsdLeg(row);
  if (usdLeg == null || usdLeg === 0) return null;
  const usdMag = Math.abs(usdLeg);
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
  const usdLeg = movementUsdLeg(row);
  if (usdLeg == null || usdLeg === 0) {
    const flow = clpDirectFlow(row, 1);
    return flow ? [flow] : [];
  }
  const wire = findClpWireForStockBuy(
    row.account_id,
    row.from_account_id,
    row.occurred_on,
    usdLeg
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
    const usdLeg = movementUsdLeg(row);
    const flow =
      usdLeg != null && usdLeg !== 0
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

/**
 * Deposit-inflow flows for USD-cash accounts (event-based, native-frame — 2026-08-04).
 *
 * Every balance-affecting non-interest movement is a capital event (the USD sign comes from
 * `signedUsdDeltaForAccountMovement`, the same walk the balance uses, so the USD-frame event
 * sum ≡ balance − interest by construction). `savings_earnings` is the account's own P/L and
 * never a deposit. The CLP frame is per-event, never a re-priced aggregate — a window with no
 * events reads 0 deposits in both frames (no fx drift):
 *  - equity-linked legs (`stock_buy` / `stock_sell` / `dividend_payout`) mirror the stock
 *    side's attribution exactly (wire pesos / composite / reference rate), negated — so the
 *    two legs of every internal brokerage move cancel to the peso at bucket level;
 *  - rows carrying a real CLP leg (compra conversions' counter pair) use those actual pesos;
 *  - anything else converts the USD magnitude at the event date's sell rate (same rate family
 *    as the balance valuation).
 */
export function loadUsdCashCapitalSortFlows(
  accountIds: number[]
): Map<number, EquityCapitalSortFlow[]> {
  const ids = [...new Set(accountIds.filter((id) => id > 0 && isUsdCashAccount(id)))];
  const out = new Map<number, EquityCapitalSortFlow[]>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL},
              occurred_on, note, units_delta, flow_kind, ticker
       FROM movements
       WHERE account_id IN (${ph}) OR from_account_id IN (${ph}) OR to_account_id IN (${ph})
       ORDER BY occurred_on, id`
    )
    .all(...ids, ...ids, ...ids) as MovementTransferRow[];
  const requested = new Set(ids);
  const push = (id: number, flow: EquityCapitalSortFlow): void => {
    if (flow.amt === 0 || !Number.isFinite(flow.amt)) return;
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(flow);
  };
  for (const r of rows) {
    if (r.flow_kind === "savings_earnings") continue; // interest = P/L, not capital
    for (const id of new Set([r.account_id, r.from_account_id, r.to_account_id])) {
      if (id == null || !requested.has(id)) continue;
      const usdSigned = signedUsdDeltaForAccountMovement(r, id);
      if (usdSigned === 0 || !Number.isFinite(usdSigned)) continue;
      const sign = usdSigned > 0 ? 1 : -1;
      const capitalRow: TransferCapitalRow = {
        id: r.id!,
        account_id: r.to_account_id ?? id,
        from_account_id: r.from_account_id,
        occurred_on: r.occurred_on,
        amount: r.amount,
        currency: r.currency,
        counter_amount: r.counter_amount,
        counter_currency: r.counter_currency,
        flow_kind: r.flow_kind ?? "",
      };
      if (r.flow_kind === "stock_buy") {
        for (const f of stockBuyCapitalFlows(capitalRow)) {
          push(id, {
            ...f,
            amt: -f.amt,
            amt_usd: f.amt_usd != null ? -f.amt_usd : null,
            tie: `${f.tie}:cash:${id}`,
          });
        }
        continue;
      }
      if (r.flow_kind === "stock_sell" || r.flow_kind === "dividend_payout") {
        const usdLeg = movementUsdLeg(r);
        const f =
          usdLeg != null && usdLeg !== 0
            ? usdReferenceFlow(capitalRow, 1)
            : clpDirectFlow(capitalRow, 1);
        if (f) push(id, { ...f, tie: `${f.tie}:cash:${id}` });
        continue;
      }
      const clpLeg = Math.abs(movementClpLegOrZero(r));
      const amt =
        clpLeg !== 0
          ? sign * clpLeg
          : sign *
            usdCashUsdToClpAt(Math.abs(usdSigned), r.occurred_on, `usdCashDeposit:${r.id}`);
      push(id, {
        occurred_on: r.occurred_on,
        amt,
        amt_usd: usdSigned,
        capital_kind: clpLeg !== 0 ? "clp_wire" : "usd_reference",
        tie: `u:${r.id}:${id}`,
      });
    }
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
