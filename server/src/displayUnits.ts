/**
 * The display units a request may name: the core currencies of `currencies` (CLP, USD, EUR), plus
 * `uf` where a surface accepts it. The one place a route reads `?unit=`; anything else is a 400,
 * never a silent fallback.
 *
 * A surface whose builders only know CLP and USD (or CLP, USD and UF) names what it supports, and
 * a request for any other unit is refused with an error naming the surface
 * ({@link DisplayUnitNotSupportedError}) — never served in pesos.
 */
import { db } from "./db.js";
import type { CurrenciesResponse, CurrencyDto } from "nw-tracker-contracts/dto";
import { dbStateMemo } from "./dbStateMemo.js";

const selCore = db.prepare(`SELECT code FROM currencies WHERE tier = 'core' ORDER BY code`);

/** The core currencies, memoized until the table changes. */
export function coreCurrencyCodes(): readonly string[] {
  return dbStateMemo("currencies|core", "all", () => (selCore.all() as { code: string }[]).map((r) => r.code));
}

const selCurrencies = db.prepare(
  `SELECT code, symbol, minor_digits, tier FROM currencies ORDER BY CASE tier WHEN 'core' THEN 0 ELSE 1 END, code`
);

/** `GET /api/currencies`: every loaded currency (core first), for the client's unit picker and formats. */
export function currenciesPayload(): CurrenciesResponse {
  return { currencies: selCurrencies.all() as CurrencyDto[] };
}

/** A display-unit problem in a request: the route answers it with its `status`, never a 500. */
export class DisplayUnitRequestError extends Error {
  readonly status = 400;
}

/** A surface asked for a unit its builders do not support yet. */
export class DisplayUnitNotSupportedError extends DisplayUnitRequestError {
  constructor(
    readonly unit: string,
    readonly surface: string,
    readonly supported: readonly string[]
  ) {
    super(`${surface} does not support display unit ${unit} yet (supports ${supported.join(", ")})`);
  }
}

/** `raw` as a display unit (lowercase core code, or `uf` when `allowUf`); `fallback` when absent. */
export function parseDisplayUnit(raw: unknown, fallback: string, opts?: { allowUf?: boolean }): string {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") throw new DisplayUnitRequestError(`unit must be a currency code`);
  const code = raw.toLowerCase();
  if (opts?.allowUf && code === "uf") return code;
  if (!coreCurrencyCodes().includes(code)) {
    throw new DisplayUnitRequestError(
      `unit ${raw} is not a loaded currency (${coreCurrencyCodes().join(", ")}${opts?.allowUf ? ", uf" : ""})`
    );
  }
  return code;
}

/**
 * A request's display unit: `?unit=<code>`, else CLP. With `supported`, a unit outside it throws
 * {@link DisplayUnitNotSupportedError}.
 */
export function requestDisplayUnit(
  query: Record<string, unknown>,
  opts: { surface: string; allowUf?: boolean; supported?: readonly string[] }
): string {
  const unit = parseDisplayUnit(query.unit, "clp", { allowUf: opts.allowUf });
  if (opts.supported && !opts.supported.includes(unit)) {
    throw new DisplayUnitNotSupportedError(unit, opts.surface, opts.supported);
  }
  return unit;
}

const selMinorDigits = db.prepare(`SELECT code, minor_digits FROM currencies`);

/** Minor digits of every loaded currency (UF included), memoized until the table changes. */
function minorDigitsByCode(): ReadonlyMap<string, number> {
  return dbStateMemo("currencies|minor_digits", "all", () => {
    const out = new Map<string, number>();
    for (const r of selMinorDigits.all() as { code: string; minor_digits: number }[]) out.set(r.code, r.minor_digits);
    return out;
  });
}

/** How many decimals `code` is counted in (CLP 0, USD 2, UF 4); throws for an unknown code. */
export function currencyMinorDigits(code: string): number {
  const d = minorDigitsByCode().get(code);
  if (d == null) throw new Error(`currencyMinorDigits: ${JSON.stringify(code)} is not in currencies`);
  return d;
}

/** `value` rounded to `code`'s smallest coin (a peso, a cent, a ten-thousandth of a UF). */
export function roundToCurrency(value: number, code: string): number {
  const f = 10 ** currencyMinorDigits(code);
  return Math.round(value * f) / f;
}

/** `code`'s smallest coin: 1 peso, 0,01 dollars, 0,0001 UF. */
export function currencySmallestCoin(code: string): number {
  return 10 ** -currencyMinorDigits(code);
}

/** The units the warmers build caches for: every core currency. */
export function warmedDisplayUnits(): readonly string[] {
  return coreCurrencyCodes();
}
