import {
  expenseLineGastosAmount,
  hasSplittableMortgageExpenseDepositLink,
  mortgageLinkCarryingAmount,
} from "./ccExpenseGastosAggregate";
import { gastosSumMonthForLine, type CcInstallmentGastosMode } from "./ccExpensePeriodMonth";
import {
  BILLS_CC_EXPENSE_SLUG,
  countsTowardGastosMes,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseLineBuckets";
import { expenseDepositAmortizationChartAmount } from "./expenseDepositLinks";
import type { DisplayUnit } from "./queries/keys";
import type { FlowCcExpenseCategoryChartPoint, FlowCcExpenseLineRow } from "./types";

/**
 * The calendar day a gastos line lands on in Diario.
 *
 * - One-shot purchases (and checking/manual lines) fall on the day the money moved:
 *   `purchase_on` for card lines, `occurred_on` otherwise.
 * - **Cuotas fall on their facturación's pay-by day.** A cuota has no transaction date of its
 *   own — it is billed by a statement and leaves the account on that statement's PAGAR HASTA —
 *   so the day view uses `cuota_pay_by_iso[account|billing_month]` from the server (billing
 *   calendars are never re-derived client-side).
 *
 * Consequence, documented because it surprises: in Cuotas mode a cuota billed in month M pays
 * ~10th of M+1, so Σ(cuota day buckets in calendar month M) equals the monthly split chart's
 * cuota sum at **M−1** — the same bank-frame(M) ≡ pay-frame(M+1) seam as the CC projections.
 *
 * Returns null when the line has no resolvable day (caller skips it); throws for card purchase
 * lines missing `purchase_on`, which is a parser/data regression rather than a display case.
 */
export function gastosDayForLine(
  line: FlowCcExpenseLineRow,
  payByIso: Record<string, string> | undefined
): string | null {
  if (line.line_role === "installment_cuota") {
    return payByIso?.[`${line.account_id}|${line.billing_month}`] ?? null;
  }
  if (line.source === "cc") {
    if (!line.purchase_on) {
      throw new Error(
        `gastos Diario: credit-card line ${line.statement_line_id} has no purchase_on`
      );
    }
    return line.purchase_on.slice(0, 10);
  }
  return line.occurred_on ? line.occurred_on.slice(0, 10) : null;
}

/**
 * Per-calendar-day gastos by category (Diario) — the day-grain mirror of
 * `aggregateGastosFromLines`'s `chart_monthly_by_category`. Same per-line accounting (mode
 * scope, nota-de-crédito roles, big-group exclusion, mortgage carrying/amortización split);
 * only the bucket key changes from month to {@link gastosDayForLine}.
 */
export function aggregateGastosChartPointsByDay(
  lines: readonly FlowCcExpenseLineRow[],
  chartCategorySlugs: readonly string[],
  mode: CcInstallmentGastosMode,
  excludedBigGroupSlugs: ReadonlySet<string> | undefined,
  unit: DisplayUnit,
  payByIso: Record<string, string> | undefined
): FlowCcExpenseCategoryChartPoint[] {
  const byDayCategory = new Map<string, Map<string, number>>();
  const addCategory = (day: string, slug: string, amount: number) => {
    const bucket = byDayCategory.get(day) ?? new Map<string, number>();
    bucket.set(slug, (bucket.get(slug) ?? 0) + amount);
    byDayCategory.set(day, bucket);
  };

  for (const ln of lines) {
    // `gastosSumMonthForLine` is the mode gate (empty = this line doesn't count in this mode).
    if (!gastosSumMonthForLine(ln, mode)) continue;
    if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
      continue;
    }
    const amount = expenseLineGastosAmount(ln, unit);
    if (amount <= 0) continue; // abonos/credits don't stack in the category chart
    if (ln.big_group_slug != null && excludedBigGroupSlugs?.has(ln.big_group_slug) === true) {
      continue;
    }
    const day = gastosDayForLine(ln, payByIso);
    if (!day) continue;

    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (hasSplittableMortgageExpenseDepositLink(link)) {
      if (
        (ln.line_role !== "installment_purchase_total" || mode === "total") &&
        (ln.line_role !== "installment_cuota" || mode === "split")
      ) {
        const carrying = mortgageLinkCarryingAmount(ln, link, unit);
        if (carrying > 0) addCategory(day, BILLS_CC_EXPENSE_SLUG, carrying);
        addCategory(
          day,
          REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
          expenseDepositAmortizationChartAmount(link.amortization_clp)
        );
      }
      continue;
    }
    if (countsTowardGastosMes(ln, mode)) addCategory(day, ln.category_slug, amount);
  }

  return [...byDayCategory.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => {
      const point: FlowCcExpenseCategoryChartPoint = { as_of_date: day };
      const sums = byDayCategory.get(day)!;
      for (const slug of chartCategorySlugs) {
        point[slug] = Math.round(sums.get(slug) ?? 0);
      }
      return point;
    });
}
