/**
 * Accounts valued as a **cuota ledger**: Σ `movements.units_delta` (plus transfer legs) × a
 * `fund_unit_daily` series at the date. AFP UNO (Fondo A, `afp_uno_cuota_a`, keyed by kind)
 * and AFC (Fondo de Cesantía CIC, `afc_cic`, declared per account on
 * `accounts.fund_series_key`). One predicate so every reader — marks, position meta, live
 * last points, perf cuota inflows — agrees on the set.
 *
 * An AFP account that joined UNO by a transfer from another AFP declares the series of its
 * earlier funds on `accounts.fund_series_key`: the official valor cuota of each earlier AFP
 * converted at the transfers' own cuota ratios, so its ledger counts UNO cuotas from the
 * first contribution (PARSERS.md «AFP account ledger»). That series covers the account
 * through the day before UNO credited the transfer; UNO's own series prices every later day.
 */
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { db } from "./db.js";

export const CUOTA_LEDGER_KIND_SLUGS: ReadonlySet<string> = new Set(["afp", "afc"]);

export function isCuotaLedgerKindSlug(kindSlug: string | null | undefined): boolean {
  return kindSlug != null && CUOTA_LEDGER_KIND_SLUGS.has(kindSlug);
}

/**
 * Series a cuota-ledger account prices with, or null when the account is not modeled in
 * cuotas: an `afc` account with no `fund_series_key` (demo / CI DBs, or a ledger not yet
 * derived) keeps the plain stored-mark path.
 */
export function cuotaLedgerSeriesKeyForAccount(accountId: number, kindSlug: string, asOfYmd: string): string | null {
  if (kindSlug === "afp") {
    const prior = fundSeriesKeyForAccount(accountId);
    if (prior == null) return AFP_UNO_CUOTA_SERIES_KEY;
    const last = lastSeriesDay(prior);
    if (last == null) throw new Error(`AFP account ${accountId}: its earlier-funds series «${prior}» has no rows`);
    return asOfYmd <= last ? prior : AFP_UNO_CUOTA_SERIES_KEY;
  }
  if (kindSlug === "afc") return fundSeriesKeyForAccount(accountId);
  return null;
}

function lastSeriesDay(seriesKey: string): string | null {
  const row = db.prepare(`SELECT MAX(day) AS day FROM fund_unit_daily WHERE series_key = ?`).get(seriesKey) as {
    day: string | null;
  };
  return row.day;
}

/** Display ticker for the position card of a cuota-ledger account. */
export function cuotaLedgerDisplayTicker(kindSlug: string): string {
  return kindSlug === "afp" ? "UNO-A" : "AFC CIC";
}
