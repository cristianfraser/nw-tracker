/**
 * The /projections form's fields: what each one is in the request, its bounds (the ones the
 * server enforces, from the contracts) and the group it is edited in.
 */
import {
  PROJECTION_INFLATION_BOUNDS,
  PROJECTION_MONEY_BOUNDS,
  PROJECTION_NUMBER_PARAM_BOUNDS,
} from "nw-tracker-contracts/dto/apiConstants";
import {
  projectionInflationKey,
  projectionMoneyCurrencyKey,
  type ProjectionMoneyKey,
  type ProjectionOverrides,
} from "./projectionsOverrides";
import type { ProjectionParams } from "./types";

/** The plain numeric inputs (no currency). */
export type ProjectionNumberKey = keyof typeof PROJECTION_NUMBER_PARAM_BOUNDS;

/** One form field: its request key, how it reads the server's echo and its bounds. */
export type ProjectionField =
  | { kind: "number"; key: ProjectionNumberKey }
  | { kind: "money"; key: ProjectionMoneyKey }
  | { kind: "inflation"; code: string };

export type ProjectionFieldGroupId = "growth" | "inflation" | "drawdown";
export type ProjectionFieldGroup = { id: ProjectionFieldGroupId; fields: ProjectionField[] };

export function projectionFieldKey(f: ProjectionField): string {
  return f.kind === "inflation" ? projectionInflationKey(f.code) : f.key;
}

export function projectionFieldBounds(f: ProjectionField): readonly [number, number] {
  if (f.kind === "number") return PROJECTION_NUMBER_PARAM_BOUNDS[f.key];
  return f.kind === "money" ? PROJECTION_MONEY_BOUNDS : PROJECTION_INFLATION_BOUNDS;
}

export function projectionFieldInBounds(f: ProjectionField, v: number): boolean {
  const [min, max] = projectionFieldBounds(f);
  return v >= min && v <= max;
}

/** The groups in the order drawn; one inflation field per core currency. */
export function projectionFieldGroups(inflationCodes: readonly string[]): ProjectionFieldGroup[] {
  return [
    {
      id: "growth",
      fields: [
        { kind: "number", key: "real_return_pct" },
        { kind: "money", key: "monthly_aporte" },
      ],
    },
    { id: "inflation", fields: inflationCodes.map((code): ProjectionField => ({ kind: "inflation", code })) },
    {
      id: "drawdown",
      fields: [
        { kind: "number", key: "retire_return_pct" },
        { kind: "number", key: "end_age" },
        { kind: "number", key: "swr_pct" },
        { kind: "number", key: "pct_balance_pct" },
        { kind: "money", key: "monthly_income" },
        { kind: "money", key: "monthly_rent" },
        { kind: "number", key: "liquidate_other_pct" },
      ],
    },
  ];
}

/** The server's echo of a field, in the response's unit. */
export function projectionEchoedValue(f: ProjectionField, params: ProjectionParams | undefined): number | undefined {
  if (!params) return undefined;
  if (f.kind === "inflation") return params.inflation_pct[f.code];
  return params[f.key];
}

/**
 * The overrides the request carries: only the in-bounds ones (an out-of-bounds field shows its
 * message while the page keeps the last valid figures), a money input with its currency.
 */
export function validProjectionOverrides(
  fields: readonly ProjectionField[],
  overrides: ProjectionOverrides
): ProjectionOverrides {
  const out: ProjectionOverrides = {};
  for (const f of fields) {
    const key = projectionFieldKey(f);
    const v = overrides[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !projectionFieldInBounds(f, v)) continue;
    out[key] = v;
    if (f.kind === "money") {
      const ck = projectionMoneyCurrencyKey(f.key);
      const c = overrides[ck];
      if (typeof c === "string") out[ck] = c;
    }
  }
  return out;
}

/**
 * What a field shows when not being edited: an override typed in this unit, else the server's
 * echo (a money override typed in another unit reads the echo, which is that amount converted).
 */
export function projectionFieldValue(
  f: ProjectionField,
  overrides: ProjectionOverrides,
  displayUnit: string,
  params: ProjectionParams | undefined
): number | undefined {
  const raw = overrides[projectionFieldKey(f)];
  const typedHere = f.kind !== "money" || overrides[projectionMoneyCurrencyKey(f.key)] === displayUnit;
  if (typeof raw === "number" && typedHere) return raw;
  return projectionEchoedValue(f, params);
}
