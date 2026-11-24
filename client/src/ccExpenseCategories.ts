import i18n, { ccExpenseCategoryLabel } from "./i18n";
import type { CcExpenseCategoryDto } from "./types";

const PIN_FIRST_SLUGS = ["no_cuenta", "deposits", "checking_internal_transfer"] as const;
const PIN_LAST_SLUG = "others";

function displayLocale(): string {
  return i18n.language || "es";
}

/** Picker order: No cuenta → Depósitos → A–Z → Otros. */
function categoryPickerSortKey(slug: string): [number, string] {
  const firstIdx = (PIN_FIRST_SLUGS as readonly string[]).indexOf(slug);
  if (firstIdx >= 0) return [firstIdx, ""];
  if (slug === PIN_LAST_SLUG) return [2, ""];
  return [1, ccExpenseCategoryLabel(slug)];
}

/** Picker order; each subcategory right after its parent, A–Z among siblings. */
export function sortCcExpenseCategoriesByLabel(
  categories: readonly CcExpenseCategoryDto[]
): CcExpenseCategoryDto[] {
  const locale = displayLocale();
  const byLabel = (a: CcExpenseCategoryDto, b: CcExpenseCategoryDto) => {
    const [ga, la] = categoryPickerSortKey(a.slug);
    const [gb, lb] = categoryPickerSortKey(b.slug);
    if (ga !== gb) return ga - gb;
    return la.localeCompare(lb, locale, { sensitivity: "base" });
  };
  const present = new Set(categories.map((c) => c.slug));
  const top = categories.filter((c) => c.parent_slug == null || !present.has(c.parent_slug)).sort(byLabel);
  const out: CcExpenseCategoryDto[] = [];
  for (const parent of top) {
    out.push(parent);
    out.push(...categories.filter((c) => c.parent_slug === parent.slug).sort(byLabel));
  }
  return out;
}

/** A category's label in a picker: «Parent › Child» for a subcategory. */
export function ccExpenseCategoryPathLabel(category: Pick<CcExpenseCategoryDto, "slug" | "parent_slug">): string {
  return category.parent_slug == null
    ? ccExpenseCategoryLabel(category.slug)
    : `${ccExpenseCategoryLabel(category.parent_slug)} › ${ccExpenseCategoryLabel(category.slug)}`;
}

/** Which level the expenses chart groups spend by. */
export type CcExpenseCategoryLevel = "category" | "subcategory";

/** Category pills, row selects, and bulk assign (excludes Sin clasificar). */
export function assignableCcExpenseCategories(
  categories: readonly CcExpenseCategoryDto[]
): CcExpenseCategoryDto[] {
  return sortCcExpenseCategoriesByLabel(
    categories.filter((c) => c.slug !== "unclassified")
  );
}
