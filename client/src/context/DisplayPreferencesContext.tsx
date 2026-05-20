import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import type { DisplayUnit } from "../queries/keys";

const LS_UNIT = "nw-tracker.displayUnit";
const LS_METRICS_PERIOD = "nw-tracker.metricsPeriod";
/** Legacy key when period was stored as dashboard-style `monthly` | `yearly`. */
const LS_CHART_GRANULARITY_LEGACY = "nw-tracker.chartGranularity";

function readStoredUnit(): DisplayUnit {
  try {
    const v = localStorage.getItem(LS_UNIT);
    if (v === "usd" || v === "clp") return v;
  } catch {
    /* ignore */
  }
  return "clp";
}

function readStoredMetricsPeriod(): CardGroupMetricsPeriod {
  try {
    const v = localStorage.getItem(LS_METRICS_PERIOD);
    if (v === "year" || v === "month") return v;
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
};

const DisplayPreferencesContext = createContext<DisplayPreferencesContextValue | null>(null);

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [displayUnit, setDisplayUnitState] = useState<DisplayUnit>(readStoredUnit);
  const [metricsPeriod, setMetricsPeriodState] = useState<CardGroupMetricsPeriod>(readStoredMetricsPeriod);

  const setDisplayUnit = useCallback((u: DisplayUnit) => {
    setDisplayUnitState(u);
    try {
      localStorage.setItem(LS_UNIT, u);
    } catch {
      /* ignore */
    }
  }, []);

  const setMetricsPeriod = useCallback((p: CardGroupMetricsPeriod) => {
    setMetricsPeriodState(p);
    try {
      localStorage.setItem(LS_METRICS_PERIOD, p);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    (): DisplayPreferencesContextValue => ({
      displayUnit,
      setDisplayUnit,
      metricsPeriod,
      setMetricsPeriod,
    }),
    [displayUnit, setDisplayUnit, metricsPeriod, setMetricsPeriod]
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
