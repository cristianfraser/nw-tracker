import { countsTowardGastosMes } from "./ccExpenseLineBuckets";
import type { CcInstallmentGastosMode } from "./ccExpensePeriodMonth";
import type { CcExpenseBigGroupDto, FlowCcExpenseLineRow } from "./types";

export type BigGroupUsage = {
  slug: string;
  label: string;
  total_clp: number;
  purchase_count: number;
};

/** Sum gastos per big group and list groups that have at least one purchase. */
export function bigGroupsWithUsage(
  lines: readonly FlowCcExpenseLineRow[],
  catalog: readonly CcExpenseBigGroupDto[],
  mode: CcInstallmentGastosMode
): BigGroupUsage[] {
  const labelBySlug = new Map(catalog.map((g) => [g.slug, g.label]));
  const totals = new Map<string, number>();
  const purchases = new Map<string, Set<string>>();

  for (const ln of lines) {
    const slug = ln.big_group_slug;
    if (!slug) continue;
    if (!countsTowardGastosMes(ln, mode)) continue;
    totals.set(slug, (totals.get(slug) ?? 0) + ln.amount_clp);
    const pk = `${ln.account_id}|${ln.purchase_key}`;
    const set = purchases.get(slug) ?? new Set<string>();
    set.add(pk);
    purchases.set(slug, set);
  }

  const slugs = [...totals.keys()].sort((a, b) => {
    const labelA = labelBySlug.get(a) ?? a;
    const labelB = labelBySlug.get(b) ?? b;
    return labelA.localeCompare(labelB, "es");
  });

  return slugs.map((slug) => ({
    slug,
    label: labelBySlug.get(slug) ?? slug,
    total_clp: Math.round(totals.get(slug) ?? 0),
    purchase_count: purchases.get(slug)?.size ?? 0,
  }));
}

export function activeBigGroupSlugs(
  lines: readonly FlowCcExpenseLineRow[]
): string[] {
  const slugs = new Set<string>();
  for (const ln of lines) {
    if (ln.big_group_slug) slugs.add(ln.big_group_slug);
  }
  return [...slugs].sort();
}
