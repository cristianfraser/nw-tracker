import { useCallback, useState } from "react";
import type { CcExpenseCategoryLevel } from "./ccExpenseCategories";

const LS_KEY = "nw-tracker.ccExpenseCategoryLevel";

function readStoredLevel(): CcExpenseCategoryLevel {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "category" || v === "subcategory") return v;
  } catch {
    /* ignore */
  }
  return "category";
}

/** The expenses chart's grouping level (categories, or subcategories on their own), remembered per browser. */
export function useCcExpenseCategoryLevel(): {
  categoryLevel: CcExpenseCategoryLevel;
  setCategoryLevel: (level: CcExpenseCategoryLevel) => void;
} {
  const [categoryLevel, setLevelState] = useState<CcExpenseCategoryLevel>(readStoredLevel);
  const setCategoryLevel = useCallback((level: CcExpenseCategoryLevel) => {
    setLevelState(level);
    try {
      localStorage.setItem(LS_KEY, level);
    } catch {
      /* ignore */
    }
  }, []);
  return { categoryLevel, setCategoryLevel };
}
