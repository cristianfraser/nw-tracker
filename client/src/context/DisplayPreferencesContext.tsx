import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import {
  DAILY_SESSIONS_LS_KEY,
  DISPLAY_UNIT_LS_KEY,
  METRICS_PERIOD_LS_KEY,
  parseDailySessions,
  parsePreferenceStorageChange,
  type DailySessionsWindow,
} from "../displayPreferenceStorageSync";
import { setDecimalSeparatorForFormatting } from "../format";
import i18n from "../i18n";
import {
  persistLanguage,
  readInitialLanguage,
  type AppLanguage,
} from "../languagePreference";
import {
  persistDecimalSeparator,
  readInitialDecimalSeparator,
  type DecimalSeparator,
} from "../numberFormatPreference";
import type { DisplayUnit } from "../queries/keys";

/** Legacy key when period was stored as dashboard-style `monthly` | `yearly`. */
const LS_CHART_GRANULARITY_LEGACY = "nw-tracker.chartGranularity";

function readStoredUnit(): DisplayUnit {
  try {
    const v = localStorage.getItem(DISPLAY_UNIT_LS_KEY);
    if (v === "usd" || v === "clp") return v;
  } catch {
    /* ignore */
  }
  return "clp";
}

function readStoredMetricsPeriod(): CardGroupMetricsPeriod {
  try {
    const v = localStorage.getItem(METRICS_PERIOD_LS_KEY);
    if (v === "day" || v === "year" || v === "month") return v;
    const legacy = localStorage.getItem(LS_CHART_GRANULARITY_LEGACY);
    if (legacy === "yearly") return "year";
    if (legacy === "monthly") return "month";
  } catch {
    /* ignore */
  }
  return "month";
}

type DisplayPreferencesContextValue = {
  displayUnit: DisplayUnit;
  setDisplayUnit: (u: DisplayUnit) => void;
  /** MTD vs YTD for card metrics, title deltas, and dashboard chart rollups (`month` = MTD, `year` = YTD). */
  metricsPeriod: CardGroupMetricsPeriod;
  setMetricsPeriod: (p: CardGroupMetricsPeriod) => void;
  /** Day-view window in sessions (daily charts + detalle por día). */
  dailySessions: DailySessionsWindow;
  setDailySessions: (s: DailySessionsWindow) => void;
  /** Separator convention shared by every number, whatever the display currency. */
  decimalSeparator: DecimalSeparator;
  setDecimalSeparator: (s: DecimalSeparator) => void;
  /** UI language (es | en); dates and the decimal separator are independent of it. */
  language: AppLanguage;
  setLanguage: (l: AppLanguage) => void;
};

const DisplayPreferencesContext = createContext<DisplayPreferencesContextValue | null>(null);

function readStoredDailySessions(): DailySessionsWindow {
  try {
    const v = parseDailySessions(localStorage.getItem(DAILY_SESSIONS_LS_KEY));
    if (v != null) return v;
  } catch {
    /* ignore */
  }
  return 90;
}

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [displayUnit, setDisplayUnitState] = useState<DisplayUnit>(readStoredUnit);
  const [metricsPeriod, setMetricsPeriodState] = useState<CardGroupMetricsPeriod>(readStoredMetricsPeriod);
  const [dailySessions, setDailySessionsState] = useState<DailySessionsWindow>(readStoredDailySessions);
  const [decimalSeparator, setDecimalSeparatorState] = useState<DecimalSeparator>(
    readInitialDecimalSeparator
  );
  const [language, setLanguageState] = useState<AppLanguage>(readInitialLanguage);

  // Each preference splits into apply (side effects + state, shared with the
  // cross-tab storage handler below) and set (apply + persist; user-initiated).
  const applyDecimalSeparator = useCallback((s: DecimalSeparator) => {
    // Update the module-level formatter locale before React re-renders.
    setDecimalSeparatorForFormatting(s);
    setDecimalSeparatorState(s);
  }, []);

  const applyLanguage = useCallback((l: AppLanguage) => {
    // changeLanguage notifies react-i18next subscribers; the context state change
    // re-renders AppTree top-down so module-level i18n.t helpers re-run too.
    void i18n.changeLanguage(l);
    setLanguageState(l);
  }, []);

  const setDisplayUnit = useCallback((u: DisplayUnit) => {
    setDisplayUnitState(u);
    try {
      localStorage.setItem(DISPLAY_UNIT_LS_KEY, u);
    } catch {
      /* ignore */
    }
  }, []);

  const setMetricsPeriod = useCallback((p: CardGroupMetricsPeriod) => {
    setMetricsPeriodState(p);
    try {
      localStorage.setItem(METRICS_PERIOD_LS_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  const setDailySessions = useCallback((s: DailySessionsWindow) => {
    setDailySessionsState(s);
    try {
      localStorage.setItem(DAILY_SESSIONS_LS_KEY, String(s));
    } catch {
      /* ignore */
    }
  }, []);

  const setDecimalSeparator = useCallback(
    (s: DecimalSeparator) => {
      applyDecimalSeparator(s);
      persistDecimalSeparator(s);
    },
    [applyDecimalSeparator]
  );

  const setLanguage = useCallback(
    (l: AppLanguage) => {
      applyLanguage(l);
      persistLanguage(l);
    },
    [applyLanguage]
  );

  // Cross-tab sync: another tab's preference write lands here as a `storage`
  // event (other tabs only, value actually changed) — apply without persisting.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const change = parsePreferenceStorageChange(e.key, e.newValue);
      if (!change) return;
      switch (change.pref) {
        case "displayUnit":
          setDisplayUnitState(change.value);
          break;
        case "metricsPeriod":
          setMetricsPeriodState(change.value);
          break;
        case "dailySessions":
          setDailySessionsState(change.value);
          break;
        case "decimalSeparator":
          applyDecimalSeparator(change.value);
          break;
        case "language":
          applyLanguage(change.value);
          break;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyDecimalSeparator, applyLanguage]);

  const value = useMemo(
    (): DisplayPreferencesContextValue => ({
      displayUnit,
      setDisplayUnit,
      metricsPeriod,
      setMetricsPeriod,
      dailySessions,
      setDailySessions,
      decimalSeparator,
      setDecimalSeparator,
      language,
      setLanguage,
    }),
    [
      displayUnit,
      setDisplayUnit,
      metricsPeriod,
      setMetricsPeriod,
      dailySessions,
      setDailySessions,
      decimalSeparator,
      setDecimalSeparator,
      language,
      setLanguage,
    ]
  );

  return (
    <DisplayPreferencesContext.Provider value={value}>{children}</DisplayPreferencesContext.Provider>
  );
}

export function useDisplayPreferences(): DisplayPreferencesContextValue {
  const ctx = useContext(DisplayPreferencesContext);
  if (!ctx) {
    throw new Error("useDisplayPreferences must be used within DisplayPreferencesProvider");
  }
  return ctx;
}
