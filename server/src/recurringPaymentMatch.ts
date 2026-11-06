/**
 * Declared recurring payments (`recurring_payments`, «Próximos pagos»): which occurrence each
 * expense line pays, and what an unpaid occurrence is expected to cost. Pure — the caller loads
 * the entries, the expense lines and the UF (`upcomingPayments.ts`).
 *
 * An occurrence is one due date of an entry: its month and day each year (yearly) or its day each
 * month (monthly). A line pays it when its merchant or shown name contains one of the entry's
 * patterns (case- and accent-insensitive), it was bought within [due − match_days_before,
 * due + match_days_after] and — when `amount_tolerance_pct` is set — its pesos are within that % of
 * the expected pesos: a UF entry's amount × the UF of the line's day or of any of the next
 * `RECURRING_UF_LINE_DAYS` days (a listing priced at its posting day); a peso entry's placeholder
 * (`placeholderPesos`). Occurrences are settled in due-date order and a line pays at most one, the
 * nearest in days, so an earlier occurrence never leaves a line to a later one.
 */
import { addCalendarMonths } from "./ccYearMonth.js";

export type RecurringFrequency = "yearly" | "monthly";
export type RecurringCurrency = "clp" | "uf";
/** `covered`: a payment of the same thing made earlier covers this due date (a whole-year permit paid in March). */
export type RecurringStatus = "paid" | "covered" | "overdue" | "upcoming";

export type RecurringEntry = {
  id: number;
  name: string;
  detail: string | null;
  /** Manual entries are paid by hand and listed in «Próximos pagos»; automatic ones are charged and only matched. */
  manual: boolean;
  frequency: RecurringFrequency;
  /** Yearly entries only; monthly entries store null. */
  due_month: number | null;
  due_day: number;
  /** Pesos for a CLP entry (its stated placeholder), UF for a UF entry. */
  amount: number;
  currency: RecurringCurrency;
  patterns: string[];
  match_days_before: number;
  match_days_after: number;
  /** Null = any amount matches. */
  amount_tolerance_pct: number | null;
  /** When it was declared (`YYYY-MM-DD HH:MM:SS`): an occurrence due before then is not asked for. */
  created_at: string;
};

/** An expense line as the matcher sees it. `ref` names it uniquely (its source and statement line id). */
export type RecurringLine = {
  ref: string;
  purchase_on: string | null;
  merchant: string | null;
  display_merchant: string | null;
  amount_clp: number;
  /**
   * The last day this payment covers, when its document says so (a vehicle permit's expiry): a
   * later occurrence of the same payment due before then is not asked for.
   */
  covers_through?: string | null;
};

export type RecurringMatch = {
  ref: string;
  purchase_on: string;
  merchant: string | null;
  amount_clp: number;
  covers_through: string | null;
};

export type RecurringOccurrence = {
  entry: RecurringEntry;
  due_iso: string;
  status: RecurringStatus;
  matched: RecurringMatch | null;
  /** Paid: the matched line's pesos. Unpaid: the placeholder (peso entries) or the UF amount on the due day. */
  amount_clp: number;
  /** No document states the amount: an unpaid peso placeholder, or a UF amount past the last published UF. */
  estimated: boolean;
  /** Peso entries: the placeholder the occurrence is matched against; null for UF entries. */
  expected_clp: number | null;
  /** Inside the window the dashboard shows: declared, from its window's start, up to the horizon. */
  exposed: boolean;
};

export type RecurringModelInput = {
  entries: readonly RecurringEntry[];
  lines: readonly RecurringLine[];
  todayYmd: string;
  /** The last day an occurrence is considered (the horizon's last month end). */
  horizonEndYmd: string;
  ufOn: (ymd: string) => number;
  /** The last day with a published UF; later UF values are projections. */
  ufKnownThrough: string;
};

/** Days after a UF entry's line's day whose UF may price it (a listing priced at its posting day). */
export const RECURRING_UF_LINE_DAYS = 5;

/** How far before an entry's declaration its occurrences are still settled (history for placeholders). */
const LOOKBACK_DAYS = 400;

type DatedLine = RecurringLine & { purchase_on: string };

export function lastDayOfMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `YYYY-MM-DD` for a day of a month, clamped to the month's length. */
export function dayInMonth(ym: string, day: number): string {
  return `${ym}-${String(Math.min(day, lastDayOfMonth(ym))).padStart(2, "0")}`;
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function foldUpper(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

function exposeFrom(entry: RecurringEntry, todayYmd: string): string {
  return entry.frequency === "monthly"
    ? `${addCalendarMonths(todayYmd.slice(0, 7), -1)}-01`
    : `${todayYmd.slice(0, 4)}-01-01`;
}

function dueDatesBetween(entry: RecurringEntry, fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const consider = (ym: string) => {
    const due = dayInMonth(ym, entry.due_day);
    if (due >= fromYmd && due <= toYmd) out.push(due);
  };
  if (entry.frequency === "yearly") {
    if (entry.due_month == null) throw new Error(`Recurring payment ${entry.id}: yearly without a due month`);
    const month = String(entry.due_month).padStart(2, "0");
    for (let y = Number(fromYmd.slice(0, 4)); y <= Number(toYmd.slice(0, 4)); y += 1) consider(`${y}-${month}`);
  } else {
    for (let ym = fromYmd.slice(0, 7); ym <= toYmd.slice(0, 7); ym = addCalendarMonths(ym, 1)) consider(ym);
  }
  return out;
}

function merchantMatches(line: RecurringLine, foldedPatterns: readonly string[]): boolean {
  return [line.merchant, line.display_merchant].some(
    (m) => m != null && foldedPatterns.some((p) => foldUpper(m).includes(p))
  );
}

function amountFits(entry: RecurringEntry, line: DatedLine, expectedClp: number | null, ufOn: (ymd: string) => number): boolean {
  if (entry.amount_tolerance_pct == null) return true;
  // A line whose document says what it covers (a vehicle permit) is that payment whatever its
  // amount: a whole year paid in March is twice the cuota the placeholder expects.
  if (line.covers_through != null) return true;
  const tolerance = entry.amount_tolerance_pct / 100;
  if (entry.currency === "clp") {
    if (expectedClp == null) throw new Error(`Recurring payment ${entry.id}: no expected pesos to match against`);
    return Math.abs(line.amount_clp - expectedClp) <= tolerance * expectedClp;
  }
  for (let k = 0; k <= RECURRING_UF_LINE_DAYS; k += 1) {
    const want = Math.round(entry.amount * ufOn(addDays(line.purchase_on, k)));
    if (Math.abs(line.amount_clp - want) <= tolerance * want) return true;
  }
  return false;
}

/** Whether a line fits an occurrence: pattern, date window and amount. Claims are not considered. */
function lineFitsOccurrence(
  entry: RecurringEntry,
  dueYmd: string,
  expectedClp: number | null,
  line: DatedLine,
  ufOn: (ymd: string) => number
): boolean {
  if (line.purchase_on < addDays(dueYmd, -entry.match_days_before)) return false;
  if (line.purchase_on > addDays(dueYmd, entry.match_days_after)) return false;
  if (!merchantMatches(line, entry.patterns.map(foldUpper))) return false;
  return amountFits(entry, line, expectedClp, ufOn);
}

/**
 * The pesos a peso entry's occurrence is expected to cost: the most recent matched payment before
 * it, of the same entry — or of another entry with the same name and frequency paid in the same
 * year (the first of two cuotas sets the second's amount) — else the entry's stated amount.
 */
export function placeholderPesos(entry: RecurringEntry, dueYmd: string, decided: readonly RecurringOccurrence[]): number {
  let best: { date: string; amount: number } | null = null;
  for (const d of decided) {
    if (d.matched == null || d.entry.currency !== "clp" || d.due_iso >= dueYmd) continue;
    const own = d.entry.id === entry.id;
    const sibling =
      !own &&
      d.entry.name === entry.name &&
      d.entry.frequency === entry.frequency &&
      d.due_iso.slice(0, 4) === dueYmd.slice(0, 4);
    if (!own && !sibling) continue;
    if (best == null || d.matched.purchase_on > best.date) best = { date: d.matched.purchase_on, amount: d.matched.amount_clp };
  }
  return best ? best.amount : entry.amount;
}

function nearestFittingLine(
  entry: RecurringEntry,
  dueYmd: string,
  expectedClp: number | null,
  lines: readonly DatedLine[],
  claimed: ReadonlySet<string>,
  ufOn: (ymd: string) => number
): DatedLine | null {
  const foldedPatterns = entry.patterns.map(foldUpper);
  let best: DatedLine | null = null;
  let bestGap = Infinity;
  for (const line of lines) {
    if (claimed.has(line.ref)) continue;
    if (line.purchase_on < addDays(dueYmd, -entry.match_days_before)) continue;
    if (line.purchase_on > addDays(dueYmd, entry.match_days_after)) continue;
    if (!merchantMatches(line, foldedPatterns)) continue;
    if (!amountFits(entry, line, expectedClp, ufOn)) continue;
    const gap = Math.abs(daysBetween(dueYmd, line.purchase_on));
    if (best == null || gap < bestGap || (gap === bestGap && line.ref < best.ref)) {
      best = line;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Every occurrence of every entry from `LOOKBACK_DAYS` before its declaration to the horizon, each
 * with its status and the line that pays it, settled in due-date order. The caller shows the
 * `exposed` ones: manual unpaid ones in «Próximos pagos», automatic ones in their own list.
 */
/**
 * Whether an earlier payment of the same thing (this entry, or another with the same name and
 * frequency) covers `dueYmd`: its document says it covers a day after it. A permit's first cuota
 * expires on the second cuota's due day itself, so it never covers it; a whole-year one does.
 */
function coveredBy(entry: RecurringEntry, dueYmd: string, decided: readonly RecurringOccurrence[]): RecurringMatch | null {
  for (const d of decided) {
    const m = d.matched;
    if (m?.covers_through == null || d.due_iso >= dueYmd) continue;
    const same = d.entry.id === entry.id || (d.entry.name === entry.name && d.entry.frequency === entry.frequency);
    if (same && m.covers_through > dueYmd) return m;
  }
  return null;
}

export function matchRecurringPayments(input: RecurringModelInput): RecurringOccurrence[] {
  const pending: { entry: RecurringEntry; due: string }[] = [];
  for (const entry of input.entries) {
    const from = addDays(entry.created_at.slice(0, 10), -LOOKBACK_DAYS);
    for (const due of dueDatesBetween(entry, from, input.horizonEndYmd)) pending.push({ entry, due });
  }
  pending.sort((a, b) => a.due.localeCompare(b.due) || a.entry.id - b.entry.id);

  const lines = input.lines.filter((l): l is DatedLine => l.purchase_on != null);
  const claimed = new Set<string>();
  const decided: RecurringOccurrence[] = [];
  for (const { entry, due } of pending) {
    const cover = coveredBy(entry, due, decided);
    if (cover) {
      decided.push({
        entry,
        due_iso: due,
        status: "covered",
        matched: null,
        amount_clp: 0,
        estimated: false,
        expected_clp: null,
        exposed: due >= entry.created_at.slice(0, 10) && due >= exposeFrom(entry, input.todayYmd) && due <= input.horizonEndYmd,
      });
      continue;
    }
    const expectedClp = entry.currency === "clp" ? placeholderPesos(entry, due, decided) : null;
    const pick = nearestFittingLine(entry, due, expectedClp, lines, claimed, input.ufOn);
    if (pick) claimed.add(pick.ref);
    const matched: RecurringMatch | null = pick
      ? { ref: pick.ref, purchase_on: pick.purchase_on, merchant: pick.merchant, amount_clp: pick.amount_clp, covers_through: pick.covers_through ?? null }
      : null;
    const unpaidAmount = expectedClp ?? Math.round(entry.amount * input.ufOn(due));
    decided.push({
      entry,
      due_iso: due,
      status: matched ? "paid" : due < input.todayYmd ? "overdue" : "upcoming",
      matched,
      amount_clp: matched ? matched.amount_clp : unpaidAmount,
      estimated: matched == null && (entry.currency === "clp" || due > input.ufKnownThrough),
      expected_clp: expectedClp,
      exposed:
        due >= entry.created_at.slice(0, 10) &&
        due >= exposeFrom(entry, input.todayYmd) &&
        due <= input.horizonEndYmd,
    });
  }
  return decided;
}

/**
 * The automatic occurrence an expense line fits (pattern, date window and amount), if any — the
 * nearest by due date. Whether it was the occurrence's claimed line does not matter: this names
 * the entry a «CONVENIO P.A.T.»-style line belongs to. `occurrences` is `matchRecurringPayments`'s
 * output for the same entries.
 */
export function automaticRecurringMatchForLine(
  line: RecurringLine,
  occurrences: readonly RecurringOccurrence[],
  ufOn: (ymd: string) => number
): RecurringOccurrence | null {
  if (line.purchase_on == null) return null;
  const dated: DatedLine = { ...line, purchase_on: line.purchase_on };
  let best: RecurringOccurrence | null = null;
  let bestGap = Infinity;
  for (const occ of occurrences) {
    if (occ.entry.manual) continue;
    if (!lineFitsOccurrence(occ.entry, occ.due_iso, occ.expected_clp, dated, ufOn)) continue;
    const gap = Math.abs(daysBetween(occ.due_iso, dated.purchase_on));
    if (best == null || gap < bestGap) {
      best = occ;
      bestGap = gap;
    }
  }
  return best;
}
