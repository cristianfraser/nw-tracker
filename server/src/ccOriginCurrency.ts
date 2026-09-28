/**
 * A card line's original currency, read from its amounts — no statement prints it.
 *
 * An international statement prints two amounts per line: MONTO MONEDA ORIGEN (what the merchant
 * charged) and MONTO US$ (what the card billed). It never names the origin's currency, and PAÍS is
 * the merchant's country, not the charge's: app stores and scooter rentals bill Chilean cards in
 * pesos under US, a ride app bills pesos under NL and another dollars under ES, and CH-coded lines
 * (the card's own dollar payments) carry dollars or 0,00. The Santander statement JSON and the web
 * paste name no currency either. So the label is decided by value, here, for every line any writer
 * stores — PDF CSV, statement JSON and web paste all insert through `importCcStatementsMerge`, and
 * `scripts/relabel-cc-line-origin-currency.ts` applies the same rule to stored lines:
 *
 *   - `usd` when the origin equals the US$ to the cent;
 *   - `clp` when origin ÷ US$ is that day's USD/CLP rate (`fx_daily` on or before the line's
 *     date) within {@link CC_ORIGIN_CLP_RATE_TOLERANCE}, widened by the US$'s own rounding to the
 *     cent (half a cent on US$ 0,50 is a 1% error in the implied rate);
 *   - null otherwise: another currency (euros, pounds, forints, Argentine pesos…), no origin, or a
 *     0,00 origin. Never a country guess.
 *
 * Nothing computes with the label or the origin amount; they are provenance.
 */
import { parseChileanNumber } from "./chileanNumber.js";
import { fxRowOnOrBefore } from "./fxRates.js";

export type CcOriginCurrency = "usd" | "clp";

/**
 * How far origin ÷ US$ may sit from `fx_daily` for a peso origin. Measured on the stored corpus
 * (2026-09-27, 1414 international lines, 2017-2026): the 619 peso origins sit between −2,7% and
 * +3,2% of the Yahoo close on or before the transaction date (median +0,04%, 601 within ±2%) —
 * the bank converts at its own rate, on its processing day — and no other origin comes within 30%
 * of it: the nearest currencies sit at +52% and −62%.
 */
export const CC_ORIGIN_CLP_RATE_TOLERANCE = 0.05;

/** Half a cent: the US$ column is rounded to the cent. */
const USD_HALF_CENT = 0.005;

/**
 * The origin amount as the CSV carries it — the statement's printed text, Chilean style
 * («2x.xxx,00», «4,25»); the statement JSON writes the same style (`ccOriginAmountCsvCell`).
 * Empty → null; anything else that is not a number throws.
 */
export function parseCcOriginAmount(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return parseChileanNumber(text);
}

/** A numeric origin amount (statement JSON) as the CSV cell {@link parseCcOriginAmount} reads. */
export function ccOriginAmountCsvCell(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error(`Non-finite origin amount ${amount}`);
  return amount.toFixed(2).replace(".", ",");
}

/**
 * The line's original currency (see the module comment). `dateIso` is the transaction date, or
 * the posting date when the line has none; it is only read for the peso test, which throws when
 * the date or its `fx_daily` row is missing rather than leave the label to chance.
 */
export function ccLineOriginCurrency(line: {
  amountOrig: number | null;
  amountUsd: number | null;
  dateIso: string | null;
}): CcOriginCurrency | null {
  const orig = Math.abs(line.amountOrig ?? 0);
  const usd = Math.abs(line.amountUsd ?? 0);
  if (orig === 0 || usd === 0) return null;
  if (Math.round(orig * 100) === Math.round(usd * 100)) return "usd";
  if (!line.dateIso) {
    throw new Error(`Card line with origin ${orig} / US$ ${usd} has no date to read the fx on`);
  }
  const fx = fxRowOnOrBefore(line.dateIso);
  if (!fx) {
    throw new Error(`No fx_daily row on or before ${line.dateIso} to label an origin amount`);
  }
  const deviation = Math.abs(orig / usd / fx.clp_per_usd - 1);
  return deviation <= CC_ORIGIN_CLP_RATE_TOLERANCE + USD_HALF_CENT / usd ? "clp" : null;
}
