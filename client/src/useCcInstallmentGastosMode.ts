import { useCallback, useState } from "react";
import type { CcInstallmentGastosMode } from "./ccExpensePeriodMonth";

const LS_KEY = "nw-tracker.ccInstallmentGastosMode";

function readStoredMode(): CcInstallmentGastosMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "split" || v === "total") return v;
  } catch {
    /* ignore */
  }
  return "split";
}

export function useCcInstallmentGastosMode(): {
  installmentMode: CcInstallmentGastosMode;
  setInstallmentMode: (mode: CcInstallmentGastosMode) => void;
} {
  const [installmentMode, setInstallmentModeState] = useState<CcInstallmentGastosMode>(readStoredMode);

  const setInstallmentMode = useCallback((mode: CcInstallmentGastosMode) => {
    setInstallmentModeState(mode);
    try {
      localStorage.setItem(LS_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  return { installmentMode, setInstallmentMode };
}
