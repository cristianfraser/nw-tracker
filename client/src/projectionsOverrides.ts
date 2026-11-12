/**
 * The /projections form's overrides, stored per browser: exactly the `GET /api/projections`
 * query parameters the user changed. A money input is stored with the currency it was typed in
 * (`monthly_aporte` + `monthly_aporte_currency`), so it keeps its amount when the display unit
 * changes (the server converts it); an inflation input is `inflation_<code>_pct`.
 */
export type ProjectionOverrides = Record<string, number | string>;

export const PROJECTION_OVERRIDES_KEY = "nw-tracker.projections.overrides.v2";
/** Before 2026-11-12: money inputs were pesos (`monthly_aporte_clp`, …). */
export const LEGACY_PROJECTION_OVERRIDES_KEY = "nw-tracker.projections.overrides";

/** The money inputs, typed in a currency. */
export const PROJECTION_MONEY_KEYS = ["monthly_aporte", "monthly_income", "monthly_rent"] as const;
export type ProjectionMoneyKey = (typeof PROJECTION_MONEY_KEYS)[number];

export function projectionMoneyCurrencyKey(key: ProjectionMoneyKey): string {
  return `${key}_currency`;
}

export function projectionInflationKey(code: string): string {
  return `inflation_${code}_pct`;
}

/** The legacy overrides in the current shape: a `<key>_clp` amount becomes `<key>` typed in pesos. */
export function migrateLegacyProjectionOverrides(legacy: Record<string, unknown>): ProjectionOverrides {
  const out: ProjectionOverrides = {};
  for (const [k, v] of Object.entries(legacy)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const money = PROJECTION_MONEY_KEYS.find((m) => k === `${m}_clp`);
    if (money) {
      out[money] = v;
      out[projectionMoneyCurrencyKey(money)] = "clp";
    } else {
      // inflation_clp_pct / inflation_usd_pct and the plain numbers keep their names.
      out[k] = v;
    }
  }
  return out;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** The stored overrides; the legacy key is migrated once (and removed). Storage may be unavailable. */
export function readStoredProjectionOverrides(storage: Storage): ProjectionOverrides {
  try {
    const current = parseObject(storage.getItem(PROJECTION_OVERRIDES_KEY));
    if (current) {
      const out: ProjectionOverrides = {};
      for (const [k, v] of Object.entries(current)) {
        if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string") out[k] = v;
      }
      return out;
    }
    const legacy = parseObject(storage.getItem(LEGACY_PROJECTION_OVERRIDES_KEY));
    if (!legacy) return {};
    const migrated = migrateLegacyProjectionOverrides(legacy);
    storage.setItem(PROJECTION_OVERRIDES_KEY, JSON.stringify(migrated));
    storage.removeItem(LEGACY_PROJECTION_OVERRIDES_KEY);
    return migrated;
  } catch {
    return {};
  }
}

export function writeStoredProjectionOverrides(storage: Storage, overrides: ProjectionOverrides): void {
  try {
    storage.setItem(PROJECTION_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // A private window or blocked storage: the overrides live for this page only.
  }
}
