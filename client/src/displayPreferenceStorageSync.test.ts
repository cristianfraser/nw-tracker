import { describe, expect, it } from "vitest";
import {
  DISPLAY_UNIT_LS_KEY,
  METRICS_PERIOD_LS_KEY,
  parsePreferenceStorageChange,
} from "./displayPreferenceStorageSync";
import { LANGUAGE_LS_KEY } from "./languagePreference";
import { DECIMAL_SEPARATOR_LS_KEY } from "./numberFormatPreference";

describe("parsePreferenceStorageChange", () => {
  it("maps each preference key's valid values", () => {
    expect(parsePreferenceStorageChange(DISPLAY_UNIT_LS_KEY, "clp")).toEqual({
      pref: "displayUnit",
      value: "clp",
    });
    expect(parsePreferenceStorageChange(DISPLAY_UNIT_LS_KEY, "usd")).toEqual({
      pref: "displayUnit",
      value: "usd",
    });
    expect(parsePreferenceStorageChange(METRICS_PERIOD_LS_KEY, "month")).toEqual({
      pref: "metricsPeriod",
      value: "month",
    });
    expect(parsePreferenceStorageChange(METRICS_PERIOD_LS_KEY, "year")).toEqual({
      pref: "metricsPeriod",
      value: "year",
    });
    expect(parsePreferenceStorageChange(DECIMAL_SEPARATOR_LS_KEY, "comma")).toEqual({
      pref: "decimalSeparator",
      value: "comma",
    });
    expect(parsePreferenceStorageChange(DECIMAL_SEPARATOR_LS_KEY, "period")).toEqual({
      pref: "decimalSeparator",
      value: "period",
    });
    expect(parsePreferenceStorageChange(LANGUAGE_LS_KEY, "es")).toEqual({
      pref: "language",
      value: "es",
    });
    expect(parsePreferenceStorageChange(LANGUAGE_LS_KEY, "en")).toEqual({
      pref: "language",
      value: "en",
    });
  });

  it("ignores invalid values for a known key", () => {
    expect(parsePreferenceStorageChange(DISPLAY_UNIT_LS_KEY, "eur")).toBeNull();
    expect(parsePreferenceStorageChange(METRICS_PERIOD_LS_KEY, "yearly")).toBeNull();
    expect(parsePreferenceStorageChange(DECIMAL_SEPARATOR_LS_KEY, "dot")).toBeNull();
    expect(parsePreferenceStorageChange(LANGUAGE_LS_KEY, "pt")).toBeNull();
    expect(parsePreferenceStorageChange(DISPLAY_UNIT_LS_KEY, "")).toBeNull();
  });

  it("ignores key removal and localStorage.clear()", () => {
    // Removal fires with newValue null; clear() fires with key null.
    expect(parsePreferenceStorageChange(DISPLAY_UNIT_LS_KEY, null)).toBeNull();
    expect(parsePreferenceStorageChange(null, null)).toBeNull();
  });

  it("ignores unrelated keys, including the legacy granularity key", () => {
    expect(parsePreferenceStorageChange("nw-tracker.chartGranularity", "yearly")).toBeNull();
    expect(parsePreferenceStorageChange("nw:dashboard-nav-snapshot-v5", "{}")).toBeNull();
    expect(parsePreferenceStorageChange("some-other-app.key", "usd")).toBeNull();
  });
});
