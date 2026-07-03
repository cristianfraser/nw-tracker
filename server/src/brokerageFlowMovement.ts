/**
 * Brokerage equity flows (SPY/VEA) stored in `movements` with `flow_kind` set.
 */

import { db } from "./db.js";
import { sumUnitsThroughDate } from "./movementTransfer.js";

export const BROKERAGE_FLOW_KINDS = [
  "deposit_clp",
  "compra_usd",
  "compra_usd_venta_clp",
  "stock_buy",
  "stock_sell",
  "dividend_usd",
  "dividend_payout",
  "savings_earnings",
  "withdrawal_clp",
  "withdrawal_usd",
  "other",
] as const;

export type BrokerageFlowKind = (typeof BROKERAGE_FLOW_KINDS)[number];

export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["stock_buy", "dividend_usd"] as const;

/** Flow kinds whose `units_delta` counts toward SPY/VEA share MTM (excludes CLP wires). */
export const BROKERAGE_SHARE_UNITS_FLOW_KINDS = [
  "compra_usd",
  "stock_buy",
  "stock_sell",
  "dividend_usd",
] as const;

export const BROKERAGE_FLOW_KIND_LABELS: Record<BrokerageFlowKind, string> = {
  deposit_clp: "Depósito CLP",
  withdrawal_clp: "Retiro CLP",
  compra_usd: "Compra USD",
  compra_usd_venta_clp: "Compra USD / Venta CLP",
  stock_buy: "Compra acciones",
  stock_sell: "Venta acciones",
  dividend_usd: "Dividendo USD",
  dividend_payout: "Dividendo",
  savings_earnings: "Interés / rentabilidad",
  withdrawal_usd: "Retiro USD",
  other: "Otro",
};

export function isShareTradeFlowKind(flowKind: string | null | undefined): boolean {
  return flowKind === "stock_buy" || flowKind === "stock_sell" || flowKind === "compra_usd";
}

export function isBrokerageFlowKind(flowKind: string | null | undefined): flowKind is BrokerageFlowKind {
  return flowKind != null && (BROKERAGE_FLOW_KINDS as readonly string[]).includes(flowKind);
}

const shareUnitsFlowPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

/** Cumulative share units through `asOfYmd` (Σ `units_delta` on compra/dividend flows). */
export function brokerageShareUnitsThroughDate(accountId: number, asOfYmd: string): number {
  return sumUnitsThroughDate(accountId, asOfYmd, BROKERAGE_SHARE_UNITS_FLOW_KINDS);
}

export function accountHasBrokerageShareUnits(accountId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM movements
         WHERE (account_id = ? OR to_account_id = ?)
           AND flow_kind IN (${shareUnitsFlowPh})
           AND COALESCE(units_delta, 0) != 0
         LIMIT 1`
      )
      .get(accountId, accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null
  );
}

/**
 * Intra-day causal rank for flows lists. Movements only carry a date, so the
 * real order of a same-day funding chain (deposit → fx → stock buy) is lost;
 * insertion id reflects manual entry order, not the cash sequence. Rank encodes
 * that cash must arrive before it is converted, be converted before it is
 * spent, and leave last. Ranks come from the movement's own `flow_kind` (not
 * the per-account perspective), so both sides of a transfer sort together.
 * Plain transfers (no flow_kind) rank just after inflows: in practice they
 * fund same-day trades. Known limit: a plain transfer sweeping out same-day
 * sell proceeds will render before the sell.
 */
export function intraDayFlowRank(flowKind: string | null | undefined): number {
  switch (flowKind) {
    case "deposit_clp":
    case "dividend_usd":
    case "dividend_payout":
    case "savings_earnings":
      return 0;
    case "stock_sell":
      return 2;
    case "compra_usd_venta_clp":
      return 3;
    case "compra_usd":
    case "stock_buy":
      return 4;
    case "withdrawal_clp":
    case "withdrawal_usd":
      return 5;
    default:
      return 1;
  }
}

/** Newest-first comparator for flows lists: date, then intra-day causal rank, then id. */
export function compareFlowRowsForDisplay(
  a: { occurred_on: string; flow_kind: string | null; id: number },
  b: { occurred_on: string; flow_kind: string | null; id: number }
): number {
  const byDate = b.occurred_on.localeCompare(a.occurred_on);
  if (byDate !== 0) return byDate;
  const byRank = intraDayFlowRank(b.flow_kind) - intraDayFlowRank(a.flow_kind);
  if (byRank !== 0) return byRank;
  return b.id - a.id;
}

/** Signed CLP for charts / deposit merge (`deposit_clp` +, `withdrawal_clp` −, trades often 0). */
export function signedAmountClpForBrokerageFlow(
  flow_kind: string,
  amount_clp: number | null,
  amount_usd: number | null
): number {
  switch (flow_kind) {
    case "deposit_clp":
      return amount_clp != null && Number.isFinite(amount_clp) ? Math.abs(amount_clp) : 0;
    case "withdrawal_clp":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    case "withdrawal_usd":
      return 0;
    case "compra_usd_venta_clp":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    default:
      return amount_clp != null && Number.isFinite(amount_clp) ? amount_clp : 0;
  }
}
