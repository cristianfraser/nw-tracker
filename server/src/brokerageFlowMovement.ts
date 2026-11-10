/**
 * Brokerage equity flows (SPY/VEA) stored in `movements` with `flow_kind` set.
 */

import { sumUnitsThroughDate } from "./movementTransfer.js";
import { OPTION_TRANSFER_FLOW_KINDS, OPTION_UNITS_FLOW_KINDS } from "./optionFlowKinds.js";

/** The kinds a STOCK account's movement form offers (the single-leg and cash-settled share kinds). */
export const STOCK_ACCOUNT_FLOW_KINDS = [
  "deposit_clp",
  "compra_usd",
  "compra_usd_venta_clp",
  "stock_buy",
  "stock_sell",
  "dividend_payout",
  "savings_earnings",
  "cash_fee",
  "withdrawal_clp",
  "withdrawal_usd",
  "other",
] as const;

/**
 * The kinds an OPTION CONTRACT account's form offers (`optionFlowKinds.ts`): the four premium
 * transfers and the expiry; an assignment is written by its own service, never typed as a row.
 */
export const OPTION_CONTRACT_FLOW_KINDS = [...OPTION_TRANSFER_FLOW_KINDS, "option_expire"] as const;

/** Every brokerage flow kind the movement validator accepts. */
export const BROKERAGE_FLOW_KINDS = [...STOCK_ACCOUNT_FLOW_KINDS, ...OPTION_UNITS_FLOW_KINDS] as const;
// `dividend_usd` (single-leg DRIP: dividend + reinvested units on one row) was retired
// 2026-08-02 — every dividend is a `dividend_payout` transfer, reinvestments are separate
// `stock_buy` transfers (repair-drip-dividend-splits.ts). Zero rows remain; the loader
// fail-fasts if one reappears (`assertNoDividendUsdRows` in equityBrokerageCapitalFlows).

export type BrokerageFlowKind = (typeof BROKERAGE_FLOW_KINDS)[number];

export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["stock_buy"] as const;
/** Every option kind moves contracts: the units are never optional. */
export const OPTION_UNITS_REQUIRED_FLOW_KINDS = OPTION_UNITS_FLOW_KINDS;

import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./shareUnitsFlowKinds.js";

export { BROKERAGE_SHARE_UNITS_FLOW_KINDS };

/** Kinds whose label names a currency: built from the movement's own currencies (`movementFlowTypeLabel`). */
export type CurrencyNamedFlowKind = "deposit_clp" | "withdrawal_clp" | "withdrawal_usd" | "compra_usd" | "compra_usd_venta_clp";

export const BROKERAGE_FLOW_KIND_LABELS: Record<Exclude<BrokerageFlowKind, CurrencyNamedFlowKind>, string> = {
  stock_buy: "Compra acciones",
  stock_sell: "Venta acciones",
  dividend_payout: "Dividendo",
  savings_earnings: "Interés / rentabilidad",
  cash_fee: "Comisión",
  other: "Otro",
  option_sell_open: "Venta de opción (apertura)",
  option_buy_open: "Compra de opción (apertura)",
  option_buy_close: "Compra de opción (cierre)",
  option_sell_close: "Venta de opción (cierre)",
  option_expire: "Vencimiento de opción",
  option_assign: "Asignación de opción",
};

export function isBrokerageFlowKind(flowKind: string | null | undefined): flowKind is BrokerageFlowKind {
  return flowKind != null && (BROKERAGE_FLOW_KINDS as readonly string[]).includes(flowKind);
}

/** Cumulative share units through `asOfYmd` (Σ `units_delta` on compra/dividend flows). */
export function brokerageShareUnitsThroughDate(accountId: number, asOfYmd: string): number {
  return sumUnitsThroughDate(accountId, asOfYmd, BROKERAGE_SHARE_UNITS_FLOW_KINDS);
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
    case "dividend_payout":
    case "savings_earnings":
      return 0;
    // A sold option's premium arrives like sale proceeds; a bought one's leaves like a purchase.
    case "stock_sell":
    case "option_sell_open":
    case "option_sell_close":
      return 2;
    case "compra_usd_venta_clp":
      return 3;
    case "compra_usd":
    case "stock_buy":
    case "option_buy_open":
    case "option_buy_close":
      return 4;
    // Contracts leaving without money: with the plain transfers, after the day's inflows.
    case "option_expire":
    case "option_assign":
      return 1;
    case "withdrawal_clp":
    case "withdrawal_usd":
    case "cash_fee":
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
    // Commission charged to the cash balance — always a debit (P/L cost, not capital).
    case "cash_fee":
      return amount_clp != null && Number.isFinite(amount_clp) ? -Math.abs(amount_clp) : 0;
    default:
      return amount_clp != null && Number.isFinite(amount_clp) ? amount_clp : 0;
  }
}
