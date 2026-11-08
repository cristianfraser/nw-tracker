import type { CcInstallmentGastosMode } from "./expenseLineShape";
import { usePersistedPref } from "./usePersistedPref";

const parseMode = (raw: string | null): CcInstallmentGastosMode => (raw === "total" ? "total" : "split");
const asText = (mode: CcInstallmentGastosMode) => mode;

export function useCcInstallmentGastosMode(): {
  installmentMode: CcInstallmentGastosMode;
  setInstallmentMode: (mode: CcInstallmentGastosMode) => void;
} {
  const [installmentMode, setInstallmentMode] = usePersistedPref(
    "nw-tracker.ccInstallmentGastosMode",
    parseMode,
    asText
  );
  return { installmentMode, setInstallmentMode };
}
