import type { CcExpenseCategoryLevel } from "./ccExpenseCategories";
import { usePersistedPref } from "./usePersistedPref";

const parseLevel = (raw: string | null): CcExpenseCategoryLevel => (raw === "subcategory" ? "subcategory" : "category");
const asText = (level: CcExpenseCategoryLevel) => level;

/** The expenses chart's grouping level (categories, or subcategories on their own), remembered per browser. */
export function useCcExpenseCategoryLevel(): {
  categoryLevel: CcExpenseCategoryLevel;
  setCategoryLevel: (level: CcExpenseCategoryLevel) => void;
} {
  const [categoryLevel, setCategoryLevel] = usePersistedPref("nw-tracker.ccExpenseCategoryLevel", parseLevel, asText);
  return { categoryLevel, setCategoryLevel };
}
