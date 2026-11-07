/**
 * Accounts valued as a **cuota ledger**: Σ `movements.units_delta` (plus transfer legs) × a
 * `fund_unit_daily` series at the date. AFP fund accounts (one per AFP and fund, each on its own
 * display series `afp_<afp>_cuota_<fund>`) and AFC (Fondo de Cesantía CIC, `afc_cic`). Both
 * declare their series per account on `accounts.fund_series_key`. One predicate so every
 * reader — marks, position meta, live last points, perf cuota inflows — agrees on the set.
 *
 * A fund switch is a transfer between two fund accounts. The fund the chain left has its display
 * series ending on the day its sale price showed, so an on-or-before read keeps that account at
 * exactly the pesos that left while the money is in transit — no synthetic series, no phantom
 * P/L couplet (docs/afp-fund-accounts-plan.md, decision 2).
 */
import { AFP_UNO_CUOTA_SERIES_KEY, parseAfpDisplaySeriesKey } from "./afpUnoSeries.js";
import { accountProfileOptional, CUOTA_LEDGER_KINDS } from "./accountProfile.js";

export const CUOTA_LEDGER_KIND_SLUGS: ReadonlySet<string> = CUOTA_LEDGER_KINDS;

export function isCuotaLedgerKindSlug(kindSlug: string | null | undefined): boolean {
  return kindSlug != null && CUOTA_LEDGER_KIND_SLUGS.has(kindSlug);
}

/**
 * Series a cuota-ledger account prices with (its profile's quantity source), or null when the
 * account is not modeled in cuotas — an `afc` account with no `fund_series_key` keeps the plain
 * stored-mark path. An `afp` account with no `fund_series_key` prices with UNO Fondo A only on a
 * demo or test database (`accountProfile.ts`); on the personal database it throws.
 */
export function cuotaLedgerSeriesKeyForAccount(accountId: number): string | null {
  const q = accountProfileOptional(accountId)?.quantity;
  return q?.kind === "cuota_ledger" ? q.seriesKey : null;
}

/**
 * Display ticker for the position card of a cuota-ledger account: `<AFP>-<FUND>` from the
 * account's display series (`PLANVITAL-A`, `MODELO-A`, `UNO-A`); AFC is «AFC CIC».
 */
export function cuotaLedgerDisplayTicker(kindSlug: string, seriesKey: string | null): string {
  if (kindSlug !== "afp") return "AFC CIC";
  const parsed = parseAfpDisplaySeriesKey(seriesKey ?? AFP_UNO_CUOTA_SERIES_KEY);
  if (!parsed) throw new Error(`cuota ledger: AFP series key «${seriesKey}» is not afp_<afp>_cuota_<fund>`);
  return `${parsed.afp.toUpperCase()}-${parsed.fund}`;
}
