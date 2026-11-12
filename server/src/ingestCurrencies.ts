/**
 * The currencies an ingest document carries, checked on receipt. The contracts accept any
 * lowercase ISO 4217 code (`currencyCodeSchema`): they cannot read the database. The server holds
 * each code to its `currencies` table, and a handler whose code still handles only pesos and
 * dollars (card sub-balances, the bank and broker specifics) refuses any other with an error
 * naming the currency and the kind — a 4xx through the ingest route, never a 500.
 */
import { isLoadedCurrency } from "./displayUnits.js";
import { IngestRefusal } from "./ingestReceiver.js";

/** `code` is in `currencies`, else an `unknown_currency` refusal naming `where`. */
export function requireLoadedCurrency(code: string, where: string): string {
  if (!isLoadedCurrency(code)) {
    throw new IngestRefusal("unknown_currency", `${where}: ${JSON.stringify(code)} is not a currency the app knows (not in currencies)`);
  }
  return code;
}

/**
 * `code` narrowed to pesos or dollars: an unknown code is `unknown_currency`, a known one other
 * than CLP or USD `unsupported_currency` — `where` names the kind (and field) that cannot take it.
 */
export function pesosOrDollars(code: string, where: string): "clp" | "usd" { // convention-ok: the narrowing every pesos-and-dollars handler goes through
  requireLoadedCurrency(code, where);
  if (code === "clp" || code === "usd") return code;
  throw new IngestRefusal("unsupported_currency", `${where}: ${code.toUpperCase()} is not handled yet (pesos and dollars only)`);
}

/** `code` narrowed to dollars (a kind that only reads dollar documents). */
export function dollarsOnly(code: string, where: string): "usd" {
  requireLoadedCurrency(code, where);
  if (code === "usd") return code;
  throw new IngestRefusal("unsupported_currency", `${where}: ${code.toUpperCase()} is not handled yet (dollars only)`);
}
