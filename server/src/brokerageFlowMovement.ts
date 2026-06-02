/**
 * Brokerage equity flows (SPY/VEA) stored in `movements` with `flow_kind` set.
 */

import { db } from "./db.js";

export const BROKERAGE_FLOW_KINDS = [
  "deposit_clp",
  "compra_usd",
  "dividend_usd",
  "withdrawal_clp",
  "other",
] as const;

export type BrokerageFlowKind = (typeof BROKERAGE_FLOW_KINDS)[number];

export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["compra_usd", "dividend_usd"] as const;

/** Flow kinds whose `units_delta` counts toward SPY/VEA share MTM (excludes CLP wires). */
export const BROKERAGE_SHARE_UNITS_FLOW_KINDS = ["compra_usd", "dividend_usd"] as const;

export const BROKERAGE_FLOW_KIND_LABELS: Record<BrokerageFlowKind, string> = {
  deposit_clp: "Depósito CLP",
  withdrawal_clp: "Retiro CLP",
  compra_usd: "Compra USD",
  dividend_usd: "Dividendo USD",
  other: "Otro",
};

export function isBrokerageFlowKind(flowKind: string | null | undefined): flowKind is BrokerageFlowKind {
  return flowKind != null && (BROKERAGE_FLOW_KINDS as readonly string[]).includes(flowKind);
}

const shareUnitsFlowPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

/** Cumulative share units through `asOfYmd` (Σ `units_delta` on compra/dividend flows). */
export function brokerageShareUnitsThroughDate(accountId: number, asOfYmd: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units_delta), 0) AS u
       FROM movements
       WHERE account_id = ?
         AND occurred_on <= ?
         AND flow_kind IN (${shareUnitsFlowPh})`
    )
    .get(accountId, asOfYmd, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) as { u: number } | undefined;
  return row?.u ?? 0;
}

export function accountHasBrokerageShareUnits(accountId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM movements
         WHERE account_id = ?
           AND flow_kind IN (${shareUnitsFlowPh})
           AND COALESCE(units_delta, 0) != 0
         LIMIT 1`
      )
      .get(accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null
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
    default:
      return amount_clp != null && Number.isFinite(amount_clp) ? amount_clp : 0;
  }
}
