/**
 * Cross-tab sync for the global display preferences (DisplayPreferencesContext).
 *
 * All four preferences persist to localStorage, so another tab's change arrives
 * here as a native `storage` event (fired only in *other* same-origin tabs, and
 * only when the value actually changed — no echo in the writing tab, no loops).
 * This module is the pure, node-testable half: it maps a storage event's
 * `{key, newValue}` to a typed preference change, or `null` for anything that
 * isn't a valid preference write (unrelated keys, invalid values, key removal —
 * a cleared key keeps the tab's current in-memory state; the next write
 * re-seeds it).
 */
import type { CardGroupMetricsPeriod } from "./dashboardCardBreakdown";
import { LANGUAGE_LS_KEY, type AppLanguage } from "./languagePreference";
import { DECIMAL_SEPARATOR_LS_KEY, type DecimalSeparator } from "./numberFormatPreference";
import type { DisplayUnit } from "./queries/keys";

export const DISPLAY_UNIT_LS_KEY = "nw-tracker.displayUnit";
export const METRICS_PERIOD_LS_KEY = "nw-tracker.metricsPeriod";

export type DisplayPreferenceStorageChange =
  | { pref: "displayUnit"; value: DisplayUnit }
  | { pref: "metricsPeriod"; value: CardGroupMetricsPeriod }
  | { pref: "decimalSeparator"; value: DecimalSeparator }
  | { pref: "language"; value: AppLanguage };

export function parsePreferenceStorageChange(
  key: string | null,
  newValue: string | null
): DisplayPreferenceStorageChange | null {
  if (key === null || newValue === null) return null;
  switch (key) {
    case DISPLAY_UNIT_LS_KEY:
      if (newValue === "clp" || newValue === "usd") {
        return { pref: "displayUnit", value: newValue };
      }
      return null;
    case METRICS_PERIOD_LS_KEY:
      if (newValue === "month" || newValue === "year") {
        return { pref: "metricsPeriod", value: newValue };
      }
      return null;
    case DECIMAL_SEPARATOR_LS_KEY:
      if (newValue === "comma" || newValue === "period") {
        return { pref: "decimalSeparator", value: newValue };
      }
      return null;
    case LANGUAGE_LS_KEY:
      if (newValue === "es" || newValue === "en") {
        return { pref: "language", value: newValue };
      }
      return null;
    default:
      return null;
  }
}
