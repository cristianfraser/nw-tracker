/**
 * Accounts valued as a **cuota ledger**: Σ `movements.units_delta` (plus transfer legs) × a
 * `fund_unit_daily` series at the date. AFP UNO (Fondo A, `afp_uno_cuota_a`, keyed by kind)
 * and AFC (Fondo de Cesantía CIC, `afc_cic`, declared per account on
 * `accounts.fund_series_key`). One predicate so every reader — marks, position meta, live
 * last points, perf cuota inflows — agrees on the set.
 */
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";

export const CUOTA_LEDGER_KIND_SLUGS: ReadonlySet<string> = new Set(["afp", "afc"]);

export function isCuotaLedgerKindSlug(kindSlug: string | null | undefined): boolean {
  return kindSlug != null && CUOTA_LEDGER_KIND_SLUGS.has(kindSlug);
}

/**
 * Series a cuota-ledger account prices with, or null when the account is not modeled in
 * cuotas: an `afc` account with no `fund_series_key` (demo / CI DBs, or a ledger not yet
 * derived) keeps the plain stored-mark path.
 */
export function cuotaLedgerSeriesKeyForAccount(accountId: number, kindSlug: string): string | null {
  if (kindSlug === "afp") return AFP_UNO_CUOTA_SERIES_KEY;
  if (kindSlug === "afc") return fundSeriesKeyForAccount(accountId);
  return null;
}

/** Display ticker for the position card of a cuota-ledger account. */
export function cuotaLedgerDisplayTicker(kindSlug: string): string {
  return kindSlug === "afp" ? "UNO-A" : "AFC CIC";
}
