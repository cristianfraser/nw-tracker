/**
 * The display units a request may name: the core currencies of `currencies` (CLP, USD, EUR), plus
 * `uf` where a surface accepts it. The one place a route reads `?unit=`; anything else is a 400,
 * never a silent fallback.
 *
 * `include_usd=1` / `include_uf=1` are a deprecated alias of `unit=usd` / `unit=uf`, accepted
 * until every client sends `unit`.
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

function truthyFlag(v: unknown): boolean {
  return v === "1" || v === "true";
}

/** The units every surface built before the any-currency work supports. */
export const LEGACY_DISPLAY_UNITS = ["clp", "usd"] as const;
export const LEGACY_DISPLAY_UNITS_WITH_UF = ["clp", "usd", "uf"] as const;
export type LegacyDisplayUnit = (typeof LEGACY_DISPLAY_UNITS)[number];

/**
 * A request's display unit: `?unit=<code>`, else the deprecated `include_usd` / `include_uf`
 * flags, else CLP. With `supported`, a unit outside it throws {@link DisplayUnitNotSupportedError}.
 */
export function requestDisplayUnit(
  query: Record<string, unknown>,
  opts: { surface: string; allowUf?: boolean; supported?: readonly string[] }
): string {
  let unit: string;
  if (query.unit != null && query.unit !== "") {
    unit = parseDisplayUnit(query.unit, "clp", { allowUf: opts.allowUf });
  } else if (truthyFlag(query.include_usd)) {
    unit = "usd";
  } else if (opts.allowUf && truthyFlag(query.include_uf)) {
    unit = "uf";
  } else {
    unit = "clp";
  }
  if (opts.supported && !opts.supported.includes(unit)) {
    throw new DisplayUnitNotSupportedError(unit, opts.surface, opts.supported);
  }
  return unit;
}

/** `unit` narrowed to CLP / USD for a builder that knows only those; any other unit throws. */
export function requireLegacyDisplayUnit(unit: string, surface: string): LegacyDisplayUnit {
  if (unit === "clp" || unit === "usd") return unit;
  throw new DisplayUnitNotSupportedError(unit, surface, LEGACY_DISPLAY_UNITS);
}

/** The units the warmers build caches for: every core currency the surfaces support today. */
export function warmedDisplayUnits(): readonly LegacyDisplayUnit[] {
  return LEGACY_DISPLAY_UNITS;
}
