/**
 * Surfaces whose payloads carry only pesos and dollars (`*_clp` / `*_usd` twins) until their
 * stream moves them to one value per requested unit (`docs/any-currency-plan.md`). Asked for any
 * other display unit they throw an error naming the surface (the route's error boundary shows
 * it) — never pesos under a € sign.
 */
import type { DisplayUnit } from "./queries/keys";

export type LegacyDisplayUnit = "clp" | "usd";

export class DisplayUnitNotSupportedError extends Error {
  constructor(
    readonly unit: DisplayUnit,
    readonly surface: string
  ) {
    super(`${surface} does not support display unit ${unit.toUpperCase()} yet (CLP and USD only)`);
  }
}

/** `unit` narrowed to CLP / USD for a surface that knows only those; any other unit throws. */
export function legacyDisplayUnit(unit: DisplayUnit, surface: string): LegacyDisplayUnit {
  if (unit === "clp" || unit === "usd") return unit;
  throw new DisplayUnitNotSupportedError(unit, surface);
}
