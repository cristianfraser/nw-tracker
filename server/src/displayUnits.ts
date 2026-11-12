/**
 * The display units a request may name: the core currencies of `currencies` (CLP, USD, EUR). The
 * one place a route reads `?unit=`; anything else is a 400, never a silent fallback.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";

const selCore = db.prepare(`SELECT code FROM currencies WHERE tier = 'core' ORDER BY code`);

/** The core currencies, memoized until the table changes. */
export function coreCurrencyCodes(): readonly string[] {
  return dbStateMemo("currencies|core", "all", () => (selCore.all() as { code: string }[]).map((r) => r.code));
}

/** `raw` as a display unit (lowercase core code); `fallback` when absent; throws on anything else. */
export function parseDisplayUnit(raw: unknown, fallback: string): string {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") throw new Error(`unit must be a currency code`);
  const code = raw.toLowerCase();
  if (!coreCurrencyCodes().includes(code)) {
    throw new Error(`unit ${raw} is not a loaded currency (${coreCurrencyCodes().join(", ")})`);
  }
  return code;
}
