/**
 * `fund_unit_daily` display series of an AFP fund's valor cuota — the official value of each
 * business day on the day it is published (`afpUnoOfficialSync.ts`, `afpDisplayFrame.ts`). One
 * series per (AFP, fund), keyed `afp_<afp>_cuota_<fund>`; every AFP account declares the series
 * it prices with on `accounts.fund_series_key` (`cuotaLedgerAccounts.ts`).
 */

/** `afp_<afp>_cuota_<fund>` — `afp` a lowercase slug (`uno`, `planvital`), `fund` one letter A–E. */
export function afpDisplaySeriesKey(afp: string, fund: string): string {
  const a = afp.toLowerCase();
  const f = fund.toLowerCase();
  if (!/^[a-z]+$/.test(a)) throw new Error(`afp display series: invalid AFP slug «${afp}»`);
  if (!/^[a-e]$/.test(f)) throw new Error(`afp display series: invalid fund «${fund}» (A–E)`);
  return `afp_${a}_cuota_${f}`;
}

/** `afp_uno_cuota_a` → `{ afp: "uno", fund: "A" }`; null for any other key. */
export function parseAfpDisplaySeriesKey(key: string): { afp: string; fund: string } | null {
  const m = /^afp_([a-z]+)_cuota_([a-e])$/.exec(key);
  if (!m) return null;
  return { afp: m[1]!, fund: m[2]!.toUpperCase() };
}

/** AFP UNO's Fondo A, the series the nightly official sync writes. */
export const AFP_UNO_CUOTA_SERIES_KEY = afpDisplaySeriesKey("uno", "A");
