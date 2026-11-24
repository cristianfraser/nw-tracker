/**
 * The day an expense line happened, for the surfaces that place lines on days («Últimos
 * movimientos», the Expenses page by spending day). A card credit is dated by the day it reached
 * the ledger, never by its printed transaction date, which a bank often sets to the original
 * purchase's day: the day its flow was first seen, else the printed posting date when later than
 * the transaction date, else the statement close (or the transaction date while the close is still
 * ahead: an open facturación's close is a future date). Any other line keeps its purchase day (the
 * movement's day for checking). A leaf: line money only.
 */
import type { Money } from "nw-tracker-contracts/dto/flows";
import { lineAmount } from "./lineMoney.js";

/** The fields the rule reads (structural: a finished server line or a wire line). */
export type DatedLine = {
  source: string;
  purchase_on: string | null;
  occurred_on: string;
  first_seen_on?: string | null;
  posting_on?: string | null;
  amount?: Money;
  annulment?: unknown;
};

export function movementOn(
  line: DatedLine,
  todayYmd: string
): string {
  const purchaseOn = line.purchase_on ?? line.occurred_on;
  // An annulment is dated the day the bank dropped the purchase, never by arrival.
  if (line.source !== "cc" || line.annulment != null || lineAmount(line).value >= 0) return purchaseOn;
  if (line.first_seen_on) return line.first_seen_on;
  if (line.posting_on && line.posting_on > purchaseOn) return line.posting_on;
  return line.occurred_on <= todayYmd ? line.occurred_on : purchaseOn;
}
