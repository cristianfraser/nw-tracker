/**
 * Stored `valuations` rows in any currency (migration 260): a row is a quantity of what the
 * account holds, in `currency`. Readers select `value` + `currency` and either
 *
 * - convert it where they need a figure in another unit ({@link storedValuationInUnit}, once,
 *   through `valueConvert.ts`), or
 * - assert the currency the account's kind states its rows in ({@link assertValuationCurrency})
 *   where the reader is kind-specific (a card's CLP anchor values, an AFP's peso marks).
 *
 * A property's rows are its appraisals ({@link valuationsAreAppraisals}): its value is net equity,
 * derived by the depto ledger from the appraisal and the loan balance, so the generic mark
 * readers leave them out.
 */
import { isCurrencyCode, type CurrencyCode } from "./rates.js";
import { convertValue, type ValueSide } from "./valueConvert.js";

/** A stored row's currency as a code the converter knows; any other code throws. */
export function valuationCurrency(code: string, ctx: string): CurrencyCode {
  if (!isCurrencyCode(code)) {
    throw new Error(`${ctx}: valuation stored in '${code}', a currency no rate converts`);
  }
  return code;
}

/** Kind-specific readers: this account's rows are stated in `expected`; another currency throws. */
export function assertValuationCurrency(code: string, expected: CurrencyCode, ctx: string): void {
  if (code !== expected) {
    throw new Error(`${ctx}: valuation stored in '${code}', this reader reads ${expected}`);
  }
}

/**
 * True for the kinds whose `valuations` rows are appraisals rather than the account's value
 * (the property: its value is net equity, the appraisal less the loan balance).
 */
export function valuationsAreAppraisals(kindSlug: string): boolean {
  return kindSlug === "property";
}

/**
 * A stored row's value in `unit` on its own date, converted once at `side`. Throws when a rate
 * the conversion needs is not on file (a stored mark has no substitute).
 */
export function storedValuationInUnit(
  row: { value: number; currency: string; as_of_date: string },
  unit: CurrencyCode,
  side: ValueSide,
  ctx: string
): number {
  const from = valuationCurrency(row.currency, ctx);
  if (from === unit) return row.value;
  const out = convertValue(row.value, from, unit, row.as_of_date, side);
  if (out == null) {
    throw new Error(`${ctx}: no ${from}→${unit} rate on or before ${row.as_of_date}`);
  }
  return out;
}
