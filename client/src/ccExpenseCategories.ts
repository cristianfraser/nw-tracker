import i18n, { ccExpenseCategoryLabel } from "./i18n";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "./ccExpenseLineBuckets";
import type { CcExpenseCategoryDto, FlowCcExpenseCategoryChartPoint } from "./types";

const PIN_FIRST_SLUGS = ["no_cuenta", "deposits", "checking_internal_transfer"] as const;
const CHART_PIN_BOTTOM_SLUGS = ["real_estate_amortization"] as const;
const PIN_LAST_SLUG = "others";

function displayLocale(): string {
  return i18n.language || "es";
}

export function compareCcExpenseCategoryLabels(aSlug: string, bSlug: string): number {
  return ccExpenseCategoryLabel(aSlug).localeCompare(
    ccExpenseCategoryLabel(bSlug),
    displayLocale(),
    { sensitivity: "base" }
  );
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

/**
 * The slug a line's spend is grouped under at a level: at «category» a subcategory's spend folds
 * into its parent; at «subcategory» every category is its own.
 */
export function ccExpenseCategorySlugAtLevel(
  categories: readonly CcExpenseCategoryDto[],
  level: CcExpenseCategoryLevel
): (slug: string) => string {
  if (level === "subcategory") return (slug) => slug;
  const parentOf = new Map(categories.filter((c) => c.parent_slug != null).map((c) => [c.slug, c.parent_slug!]));
  return (slug) => parentOf.get(slug) ?? slug;
}

/** The categories the chart stacks at a level (at «category», only the top-level ones). */
export function ccExpenseCategoriesAtLevel(
  categories: readonly CcExpenseCategoryDto[],
  level: CcExpenseCategoryLevel
): CcExpenseCategoryDto[] {
  return level === "subcategory" ? [...categories] : categories.filter((c) => c.parent_slug == null);
}
/** Category pills, row selects, and bulk assign (excludes Sin clasificar). */
export function assignableCcExpenseCategories(
  categories: readonly CcExpenseCategoryDto[]
): CcExpenseCategoryDto[] {
  return sortCcExpenseCategoriesByLabel(
    categories.filter((c) => c.slug !== "unclassified")
  );
}

export function averageCcExpenseCategoryChartAmount(
  points: readonly FlowCcExpenseCategoryChartPoint[],
  slug: string
): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const row of points) {
    const v = row[slug];
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum / points.length;
}

/** Stacked chart / legend: amortización at stack base, then highest average gasto first, Otros penultimate, Sin clasificar last. */
export function chartCcExpenseCategories(
  categories: readonly CcExpenseCategoryDto[],
  points: readonly FlowCcExpenseCategoryChartPoint[] = []
): CcExpenseCategoryDto[] {
  const pinBottom = categories.filter((c) =>
    (CHART_PIN_BOTTOM_SLUGS as readonly string[]).includes(c.slug)
  );
  const assignable = categories.filter(
    (c) =>
      c.slug !== "unclassified" &&
      c.slug !== PIN_LAST_SLUG &&
      (!CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(c.slug) ||
        (CHART_PIN_BOTTOM_SLUGS as readonly string[]).includes(c.slug))
  );
  const others = categories.find((c) => c.slug === PIN_LAST_SLUG);
  const unclassified = categories.find((c) => c.slug === "unclassified");

  const middlePool = assignable.filter(
    (c) => !(CHART_PIN_BOTTOM_SLUGS as readonly string[]).includes(c.slug)
  );

  const sortedMiddle =
    points.length > 0
      ? [...middlePool].sort((a, b) => {
          const avgA = averageCcExpenseCategoryChartAmount(points, a.slug);
          const avgB = averageCcExpenseCategoryChartAmount(points, b.slug);
          if (avgB !== avgA) return avgB - avgA;
          return compareCcExpenseCategoryLabels(a.slug, b.slug);
        })
      : sortCcExpenseCategoriesByLabel(middlePool);

  const tail: CcExpenseCategoryDto[] = [];
  if (others) tail.push(others);
  if (unclassified) tail.push(unclassified);

  return [...pinBottom, ...sortedMiddle, ...tail];
}
