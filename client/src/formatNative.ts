/**
 * Formatters for figures that are in one currency by their nature, not in the display unit
 * (docs/any-currency-plan.md C7). A view formats a display-unit value through the unit
 * (`formatMoney` / `formatCurrency`); it reaches for one of these only when the source fixes the
 * currency, and the name says which source. Each is the plain peso or dollar formatter.
 */
import { formatClp, formatClpUfDay, formatUsd, formatUsdFine } from "./format";

/** An F22 code, a Chilean tax figure: stated in pesos by law. */
export const formatF22Pesos = (n: number): string => formatClp(n); // convention-ok: an F22 figure is stated in pesos by law

/** A foreign document's own dollars (a broker's dividend, a US salary) beside its F22 pesos. */
export const formatTaxDocumentDollars = (n: number): string => formatUsdFine(n); // convention-ok: the foreign document's dollars, as it states them

/** A Form 1040 line: stated in whole dollars by law. */
export const formatForm1040Dollars = (n: number): string => formatUsd(n); // convention-ok: a Form 1040 line is stated in dollars by law

/** A Form 1040 figure carried to the cent (a rate base, a basis per share). */
export const formatForm1040Cents = (n: number): string => formatUsdFine(n); // convention-ok: a Form 1040 figure is stated in dollars by law

/** Chile's tax as the F22 states it, read by the 1040's foreign tax credit. */
export const formatChileTaxPesos = (n: number): string => formatClp(n); // convention-ok: Chile's tax as the F22 states it, in pesos

/** A card's billing frame: statement facturado, cuotas, cupo, the facturación and month modals. */
export const formatCardBillingPesos = (n: number): string => formatClp(n); // convention-ok: the card's billing frame is kept in pesos

/** A tracked place's bill or the payment that paid it (bill rows are pesos by CHECK). */
export const formatBillPesos = (n: number): string => formatClp(n); // convention-ok: a place's bill is stored in pesos

/** A mortgage cuota and its parts as the lender bills them. */
export const formatMortgagePesos = (n: number): string => formatClp(n); // convention-ok: a mortgage cuota is billed in pesos

/** The UF of a day in pesos (UF día). */
export const formatUfDayPesos = (n: number | null | undefined): string => formatClpUfDay(n); // convention-ok: the UF's value in pesos

/** A checking cartola's printed pesos and the ledger anchor derived from it. */
export const formatCartolaPesos = (n: number): string => formatClp(n); // convention-ok: a checking cartola prints pesos

/** A peso checking debit paired with a card payment. */
export const formatCheckingPesos = (n: number): string => formatClp(n); // convention-ok: the checking account is a peso ledger

/** A grocery receipt's printed pesos. */
export const formatReceiptPesos = (n: number): string => formatClp(n); // convention-ok: a grocery receipt prints pesos

/** A USD/CLP rate: pesos per dollar. */
export const formatPesosPerDollar = (n: number): string => formatClp(n); // convention-ok: a USD/CLP rate is pesos per dollar

/** An import preview's dollar leg, as the document states it. */
export const formatImportDollars = (n: number): string => formatUsdFine(n); // convention-ok: the imported document's dollars

/** A listed option's strike: options are listed in dollars. */
export const formatOptionStrikeDollars = (n: number): string => formatUsdFine(n); // convention-ok: options are listed in dollars
