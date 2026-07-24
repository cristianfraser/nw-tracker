/**
 * Account kinds whose movements carry a **conventional month-end date, not a real day** (the
 * cuenta ahorro sheet records mm-yyyy only), so their valuation evidence is month-precision.
 *
 * Consequence for mirror-merged transfers: such a leg keeps its ORIGINAL pre-conversion date for
 * aportes (its marks sit in that month), while every other account's balance and units follow the
 * transfer's own date — see `accountDeposits.loadTransferLegSignedFlowEvents`.
 *
 * Deliberately import-free: both `accountBucket.ts` (behavior helper) and `flowsCheckingGastos.ts`
 * (deposit matcher) read it, and those two sit on opposite sides of an import cycle.
 */
export const MONTH_PRECISION_ACCOUNT_KIND_SLUGS = new Set(["cuenta_ahorro_vivienda"]);
