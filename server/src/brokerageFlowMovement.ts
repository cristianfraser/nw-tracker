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
