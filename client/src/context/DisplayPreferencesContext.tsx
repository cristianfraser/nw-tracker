import { isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DISPLAY_UNIT_LS_KEY,
  parsePreferenceStorageChange,
} from "../displayPreferenceStorageSync";
import { persistChartStyle, readInitialChartStyle, type ChartStyle } from "../chartStylePreference";
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
import { isDisplayUnitCode, type DisplayUnit } from "../queries/keys";
import { sweepPersistedPayloads } from "../queries/persistedPayloadCache";

function readStoredUnit(): DisplayUnit {
  try {
    const v = localStorage.getItem(DISPLAY_UNIT_LS_KEY);
    if (isDisplayUnitCode(v)) return v;
  } catch {
    /* ignore */
  }
  return "clp";
}

/** Before any switch, the unit a held placeholder would be in: the other of pesos and dollars. */
function initialPreviousUnit(unit: DisplayUnit): DisplayUnit {
  return isHomeCurrency(unit) ? "usd" : "clp";
}

type UnitState = { unit: DisplayUnit; previous: DisplayUnit };

function switchedUnit(state: UnitState, next: DisplayUnit): UnitState {
  return next === state.unit ? state : { unit: next, previous: state.unit };
}

type DisplayPreferencesContextValue = {
  displayUnit: DisplayUnit;
  /**
   * The unit shown before the latest switch: the one a page's held (keep-previous) data is in
   * while the new unit loads.
   */
  previousDisplayUnit: DisplayUnit;
  setDisplayUnit: (u: DisplayUnit) => void;
  /** Separator convention shared by every number, whatever the display currency. */
  decimalSeparator: DecimalSeparator;
  setDecimalSeparator: (s: DecimalSeparator) => void;
  /** UI language (es | en); dates and the decimal separator are independent of it. */
  language: AppLanguage;
  setLanguage: (l: AppLanguage) => void;
  /** Chart rendering style (plain | chalk | chalk-sketch | rough); see chartStylePreference.ts. */
  chartStyle: ChartStyle;
  setChartStyle: (s: ChartStyle) => void;
};

const DisplayPreferencesContext = createContext<DisplayPreferencesContextValue | null>(null);

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [unitState, setUnitState] = useState<UnitState>(() => {
    const unit = readStoredUnit();
    return { unit, previous: initialPreviousUnit(unit) };
  });
  const displayUnit = unitState.unit;
  const previousDisplayUnit = unitState.previous;
  const [decimalSeparator, setDecimalSeparatorState] = useState<DecimalSeparator>(
    readInitialDecimalSeparator
  );
  const [language, setLanguageState] = useState<AppLanguage>(readInitialLanguage);
  const [chartStyle, setChartStyleState] = useState<ChartStyle>(readInitialChartStyle);

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
    setUnitState((st) => switchedUnit(st, u));
    try {
      localStorage.setItem(DISPLAY_UNIT_LS_KEY, u);
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

  const setChartStyle = useCallback((s: ChartStyle) => {
    setChartStyleState(s);
    persistChartStyle(s);
  }, []);

  // The chart CSS keys on `<html data-chart-style>`; a ChartStyleScope sets the same attribute
  // on a subtree to override it there.
  useEffect(() => {
    document.documentElement.dataset.chartStyle = chartStyle;
  }, [chartStyle]);

  // Cross-tab sync: another tab's preference write lands here as a `storage`
  // event (other tabs only, value actually changed) — apply without persisting.
  useEffect(() => {
    sweepPersistedPayloads();
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const change = parsePreferenceStorageChange(e.key, e.newValue);
      if (!change) return;
      switch (change.pref) {
        case "displayUnit":
          setUnitState((st) => switchedUnit(st, change.value));
          break;
        case "decimalSeparator":
          applyDecimalSeparator(change.value);
          break;
        case "language":
          applyLanguage(change.value);
          break;
        case "chartStyle":
          setChartStyleState(change.value);
          break;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyDecimalSeparator, applyLanguage]);

  const value = useMemo(
    (): DisplayPreferencesContextValue => ({
      displayUnit,
      previousDisplayUnit,
      setDisplayUnit,
      decimalSeparator,
      setDecimalSeparator,
      language,
      setLanguage,
      chartStyle,
      setChartStyle,
    }),
    [
      displayUnit,
      previousDisplayUnit,
      setDisplayUnit,
      decimalSeparator,
      setDecimalSeparator,
      language,
      setLanguage,
      chartStyle,
      setChartStyle,
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
