/**
 * Card charges an automatic declared payment explains (`recurring_payments`, `manual = 0`): the
 * bank may first list a charge under another name (the car insurance as «CONVENIO P.A.T.» a few
 * days before it posts as «SEG AUTO SANTANDER»). A line that fits an automatic entry's pattern,
 * day window and amount carries the entry with its patterns (`recurring_payment`): it shows under
 * the name the bank posts it as, the catalog's name for a pattern its own merchant does not carry
 * (`expenseDisplayNames.ts`). When only the bank's name decided its category and none was found, it
 * takes the category of the entry's most recent charge that has one. A line with its own category,
 * or a rule for its name, keeps it.
 */
import { chileCalendarTodayYmd } from "./chileDate.js";
import { UNCLASSIFIED_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { automaticRecurringMatchForLine, matchRecurringPayments, recurringLineRef, toRecurringLine, type RecurringLine } from "./recurringPaymentMatch.js";
import { listRecurringPayments } from "./recurringPaymentsStore.js";
import { ufProjector } from "./ufProjection.js";
import { addDaysIso } from "nw-tracker-contracts";

type NamedLine = {
  source: string;
  statement_line_id: number;
  purchase_key?: string;
  purchase_on: string | null;
  merchant: string | null;
  display_merchant?: string;
  amount_clp: number;
  category_slug: string;
  category_from_bank_name?: true;
  recurring_payment?: RecurringLineEntry;
};

/** The automatic entry a line pays: its name and every merchant pattern (the display rule reads the others). */
export type RecurringLineEntry = { id: number; name: string; patterns: string[] };

export function withRecurringPaymentNames<L extends NamedLine>(lines: L[], today: string = chileCalendarTodayYmd()): L[] {
  const entries = listRecurringPayments().filter((e) => !e.manual);
  if (entries.length === 0) return lines;
  const uf = ufProjector();
  const candidates = lines.filter((l) => l.source === "cc" && l.amount_clp > 0 && l.purchase_on != null);
  const recurringLines: RecurringLine[] = candidates.map(toRecurringLine);
  const occurrences = matchRecurringPayments({
    entries,
    lines: recurringLines,
    todayYmd: today,
    // A pending listing lands days before its due date: occurrences due after today must exist too.
    horizonEndYmd: addDaysIso(today, Math.max(...entries.map((e) => e.match_days_before))),
    ufOn: uf.ufOn,
    ufKnownThrough: uf.knownThrough,
  });

  // Each entry's category: that of its most recent paid charge whose category is not «sin categoría».
  const byRef = new Map(candidates.map((l) => [recurringLineRef(l), l]));
  const categoryByEntry = new Map<number, { on: string; slug: string }>();
  for (const o of occurrences) {
    const line = o.matched ? byRef.get(o.matched.ref) : undefined;
    if (!line || line.category_slug === UNCLASSIFIED_CC_EXPENSE_SLUG) continue;
    const prev = categoryByEntry.get(o.entry.id);
    if (!prev || o.matched!.purchase_on > prev.on) categoryByEntry.set(o.entry.id, { on: o.matched!.purchase_on, slug: line.category_slug });
  }

  const byLine = new Map<string, RecurringLineEntry>();
  for (const r of recurringLines) {
    const occ = automaticRecurringMatchForLine(r, occurrences, uf.ufOn);
    if (occ) byLine.set(r.ref, { id: occ.entry.id, name: occ.entry.name, patterns: occ.entry.patterns });
  }
  if (byLine.size === 0) return lines;
  return lines.map((l) => {
    const entry = byLine.get(recurringLineRef(l));
    if (!entry) return l;
    const category = categoryByEntry.get(entry.id);
    const takesCategory = l.category_from_bank_name && l.category_slug === UNCLASSIFIED_CC_EXPENSE_SLUG && category;
    return { ...l, recurring_payment: entry, ...(takesCategory ? { category_slug: category.slug } : {}) };
  });
}
