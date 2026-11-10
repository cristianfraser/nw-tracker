/**
 * Flow kinds of an option contract account (`option_contracts`, migration 304). A leaf (no
 * imports), like `shareUnitsFlowKinds.ts`: the kind registry, the units readers and the client's
 * mirror all read it.
 *
 * Contracts are SIGNED on the ledger: a short position is negative. Every kind's units rule lives
 * in `unitsDeltaForAccountMovement` (`movementTransfer.ts`):
 * - `option_sell_open`  contract → USD cash, amount = the premium received, contracts −n;
 * - `option_buy_open`   USD cash → contract, amount = the premium paid, contracts +n;
 * - `option_buy_close`  USD cash → contract, the premium paid to close a short, contracts +n;
 * - `option_sell_close` contract → USD cash, the premium received closing a long, contracts −n;
 * - `option_expire`     single-leg on the contract, amount 0, units = −(contracts held) — like
 *                       `stock_split`, a units row with no money;
 * - `option_assign`     single-leg on the contract, units = −(contracts held), linked by
 *                       `option_assignments` to the `stock_sell` / `stock_buy` at the strike that
 *                       the same service writes on the underlying's account.
 */
export const OPTION_PREMIUM_RECEIVED_FLOW_KINDS = ["option_sell_open", "option_sell_close"] as const;
export const OPTION_PREMIUM_PAID_FLOW_KINDS = ["option_buy_open", "option_buy_close"] as const;
/** The transfer kinds: a premium moves between the contract account and USD cash. */
export const OPTION_TRANSFER_FLOW_KINDS = [...OPTION_PREMIUM_RECEIVED_FLOW_KINDS, ...OPTION_PREMIUM_PAID_FLOW_KINDS] as const;
/** The single-leg kinds: contracts leave the ledger, no money moves. */
export const OPTION_UNITS_ONLY_FLOW_KINDS = ["option_expire", "option_assign"] as const;
/** Every kind whose `units_delta` counts toward a contract account's position. */
export const OPTION_UNITS_FLOW_KINDS = [...OPTION_TRANSFER_FLOW_KINDS, ...OPTION_UNITS_ONLY_FLOW_KINDS] as const;

export type OptionFlowKind = (typeof OPTION_UNITS_FLOW_KINDS)[number];

export function isOptionFlowKind(flowKind: string | null | undefined): flowKind is OptionFlowKind {
  return flowKind != null && (OPTION_UNITS_FLOW_KINDS as readonly string[]).includes(flowKind);
}

/** Kinds whose contracts LEAVE the from-leg (the contract account is `from_account_id`). */
export function optionUnitsLeaveFromLeg(flowKind: string | null | undefined): boolean {
  return flowKind != null && (OPTION_PREMIUM_RECEIVED_FLOW_KINDS as readonly string[]).includes(flowKind);
}

/** Kinds whose contracts ARRIVE on the to-leg (the contract account is `to_account_id`). */
export function optionUnitsArriveOnToLeg(flowKind: string | null | undefined): boolean {
  return flowKind != null && (OPTION_PREMIUM_PAID_FLOW_KINDS as readonly string[]).includes(flowKind);
}
