/**
 * A fund account's cuota movements as tax-lot events (`realizeTaxLots`), for the cost per cuota
 * of the cuotas held: AFP and AFC cuota ledgers, Fintual goals, the US fund accounts. The units
 * are the ones the account's value counts (`ledgerUnitsDeltaForAccountMovement`: single-leg rows
 * on the account plus transfer legs), so the open lots always hold the ledger's cuotas.
 *
 * How each movement counts ({@link fundLotTreatment}):
 * - acquire at what it cost: a cuota inflow — an aporte, a cotización, a Fintual purchase, a
 *   transfer in (its to-leg amount: the counter leg of a cross-currency transfer, else the
 *   amount), an AFP switch's ingress (the pesos the sale produced, so the switch moves the
 *   money, not a gain or a loss, into the receiving fund);
 * - dispose: a cuota outflow — a retiro, a switch's egress, a liquidation — at what it paid;
 * - units-only rows: a commission (`cash_fee`) disposes at 0 proceeds, catch-up cuotas
 *   (`savings_earnings`) acquire at 0 cost — the treatment the AFC true-ups already document;
 * - the APV state bonus (`state_bonus`) acquires at 0 cost: it is not the holder's money, so the
 *   cost per cuota is the personal cost.
 *
 * Amounts are converted into the fund's quote currency on the movement's day (the caller's
 * `toQuote`, at the stored mid), so every lot is in the currency the cuota is priced in.
 * Anything the ledger does not explain throws: a peso row whose pesos run against its cuotas, a
 * commission that adds cuotas, catch-up cuotas that remove them.
 */
import { db } from "./db.js";
import { DEPOSIT_FLOW_KIND_STATE } from "./depositFlowKind.js";
import { CASH_FEE_FLOW_KIND, SAVINGS_EARNINGS_FLOW_KIND } from "./accountDeposits.js";
import {
  isMovementTransferRow,
  ledgerUnitsDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";
import type { TaxLotEvent } from "./taxLots.js";
import { isHomeCurrency } from "./displayUnits.js";

export type FundLotRow = MovementTransferRow & { id: number };

export type FundLotTreatment = "acquire_at_amount" | "acquire_at_zero" | "dispose_at_amount" | "dispose_at_zero";

/** How a fund movement that moves `units` (signed, for the account) counts in the lot walk. */
export function fundLotTreatment(row: Pick<FundLotRow, "id" | "flow_kind">, units: number): FundLotTreatment {
  const acquires = units > 0;
  switch (row.flow_kind) {
    case CASH_FEE_FLOW_KIND:
      if (acquires) throw new Error(`Fund tax lots: commission ${row.id} adds ${units} cuotas`);
      return "dispose_at_zero";
    case SAVINGS_EARNINGS_FLOW_KIND:
      if (!acquires) throw new Error(`Fund tax lots: catch-up cuotas ${row.id} remove ${-units} cuotas`);
      return "acquire_at_zero";
    case DEPOSIT_FLOW_KIND_STATE:
      if (!acquires) throw new Error(`Fund tax lots: state bonus ${row.id} removes ${-units} cuotas`);
      return "acquire_at_zero";
    default:
      return acquires ? "acquire_at_amount" : "dispose_at_amount";
  }
}

/** The money the movement moved into or out of `accountId`: amount and currency of its leg. */
function legMoney(row: FundLotRow, accountId: number): { amount: number; currency: string } {
  if (isMovementTransferRow(row) && row.to_account_id === accountId && row.counter_amount != null) {
    if (row.counter_currency == null) throw new Error(`Fund tax lots: transfer ${row.id} has a counter amount without a currency`);
    return { amount: row.counter_amount, currency: row.counter_currency };
  }
  return { amount: row.amount, currency: row.currency };
}

/**
 * The account's lot events, sorted (date, acquisitions before disposals, id). `toQuote` converts
 * an amount of a movement's currency into the fund's quote currency on its day (throws without a
 * rate).
 */
export function fundTaxLotEventsFromRows(
  accountId: number,
  rows: readonly FundLotRow[],
  toQuote: (amount: number, currency: string, ymd: string) => number
): TaxLotEvent[] {
  const events: TaxLotEvent[] = [];
  for (const r of rows) {
    const units = ledgerUnitsDeltaForAccountMovement(r, accountId);
    if (units === 0) continue;
    const date = r.occurred_on.slice(0, 10);
    const treatment = fundLotTreatment(r, units);
    const n = Math.abs(units);
    if (treatment === "acquire_at_zero") {
      events.push({ kind: "acquire", date, movementId: r.id, units: n, cost: 0 });
      continue;
    }
    if (treatment === "dispose_at_zero") {
      events.push({ kind: "dispose", date, movementId: r.id, units: n, proceeds: 0 });
      continue;
    }
    const leg = legMoney(r, accountId);
    if (!Number.isFinite(leg.amount)) throw new Error(`Fund tax lots: movement ${r.id} carries a non-finite amount`);
    // A single-leg peso row is signed for the account (pesos in with cuotas in); a single-leg row
    // in another currency and a transfer are positive (direction in the kind / the legs).
    const transfer = isMovementTransferRow(r);
    if (!transfer && isHomeCurrency(leg.currency) && leg.amount !== 0 && Math.sign(leg.amount) !== Math.sign(units)) {
      throw new Error(`Fund tax lots: movement ${r.id} moves ${units} cuotas against ${leg.amount} ${leg.currency}`);
    }
    if ((transfer || !isHomeCurrency(leg.currency)) && leg.amount < 0) throw new Error(`Fund tax lots: transfer ${r.id} carries a negative amount ${leg.amount}`);
    const money = toQuote(Math.abs(leg.amount), leg.currency, date);
    if (!Number.isFinite(money)) throw new Error(`Fund tax lots: movement ${r.id} has no value in the fund's currency`);
    events.push(
      treatment === "acquire_at_amount"
        ? { kind: "acquire", date, movementId: r.id, units: n, cost: money }
        : { kind: "dispose", date, movementId: r.id, units: n, proceeds: money }
    );
  }
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  return events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
}

const stmtFundRows = db.prepare(
  `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
          occurred_on, note, units_delta, counter_units_delta, flow_kind
   FROM movements
   WHERE units_delta IS NOT NULL AND (account_id = ? OR from_account_id = ? OR to_account_id = ?)
   ORDER BY occurred_on, id`
);

/** Every movement that moves the fund account's cuotas (single-leg rows and transfer legs). */
export function loadFundUnitRows(accountId: number): FundLotRow[] {
  return stmtFundRows.all(accountId, accountId, accountId) as FundLotRow[];
}

/** The fund account's lot events in its quote currency (see {@link fundTaxLotEventsFromRows}). */
export function loadFundTaxLotEvents(
  accountId: number,
  toQuote: (amount: number, currency: string, ymd: string) => number
): TaxLotEvent[] {
  return fundTaxLotEventsFromRows(accountId, loadFundUnitRows(accountId), toQuote);
}
