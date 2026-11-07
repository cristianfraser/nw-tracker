/**
 * Flow kinds whose `units_delta` counts toward a stock position's shares (excludes CLP wires).
 * A leaf (no imports): the account profile reads it to tell an equity position, and
 * `brokerageFlowMovement.ts` re-exports it for the share-count readers.
 */
export const BROKERAGE_SHARE_UNITS_FLOW_KINDS = [
  "compra_usd",
  "stock_buy",
  "stock_sell",
  // A split's new shares (`equitySplits.ts`): a single-leg units row, amount 0.
  "stock_split",
] as const;
