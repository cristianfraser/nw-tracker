/**
 * «Próximos pagos» on the home dashboard: everything due in the coming months, grouped by the
 * month it is due — the credit cards' facturaciones (`dashboardCcUpcomingPayments.ts`), the
 * mortgage cuota, each place's gastos comunes, each owned property's contribuciones and the
 * payments the user declared (`recurring_payments`, matched in `recurringPaymentMatch.ts`; the
 * automatic ones are listed apart in `automatic_recurring`). An item leaves the list once it is
 * paid; an unpaid one past its due date is overdue and counts in the current month.
 *
 * The server sends `UPCOMING_PAYMENTS_HORIZON_MONTHS` months from the current one; the panel shows
 * the first two and the rest on «Show more». Amounts a document does not state yet are estimates
 * (`estimated`, «≈»), future UF at the last twelve months' growth (`projectedUfClp`).
 */
import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { MORTGAGE_WINDOW_END_DAY } from "./mortgageCuotaDay.js";
import { buildDashboardCcUpcomingPayments, type CcUpcomingPaymentRow } from "./dashboardCcUpcomingPayments.js";
import { loadAllDeptoLedgers } from "./deptoLedgerFromMovements.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import {
  buildDeptoPaymentScenarioRows,
  firstMortgageScheduleYmd,
  mortgageScheduleYmdForCuota,
} from "./mortgageScenarioPayments.js";
import { buildMortgageUfReminder } from "./mortgageUfReminder.js";
import { nextCuotaQuoteForLoan } from "./mortgageLenderQuotes.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import { utilityBillMonth } from "./utilityBillsApply.js";
import { linePesos, loadGastosLinesForRealEstateMatching } from "./realEstateExpenseMatching.js";
import { listRecurringPayments } from "./recurringPaymentsStore.js";
import { projectedUfClp, ufProjector, type UfLookup } from "./ufProjection.js";
import {
  automaticRecurringMatchForLine,
  dayInMonth,
  matchRecurringPayments,
  type RecurringEntry,
  type RecurringFrequency,
  type RecurringLine,
  toRecurringLine,
  type RecurringOccurrence,
  type RecurringStatus,
} from "./recurringPaymentMatch.js";
import { addCalendarMonths, addDaysIso, normalizeCheckDigitId } from "nw-tracker-contracts";

export { automaticRecurringMatchForLine, dayInMonth, listRecurringPayments, matchRecurringPayments, projectedUfClp };
export type { UfLookup };
export type { RecurringEntry, RecurringLine, RecurringOccurrence } from "./recurringPaymentMatch.js";

/** Months the block covers, the current one included («Show more» shows them all). */
export const UPCOMING_PAYMENTS_HORIZON_MONTHS = 6;


/** Contribuciones cuotas: due on the last day of April, June, September and November (Tesorería). */
export const CONTRIBUCIONES_DUE_MONTHS = [4, 6, 9, 11] as const;

export type UpcomingPaymentKind = "card" | "mortgage" | "hoa" | "contribuciones" | "recurring";

/**
 * The detail of one occurrence, apart from its name: a card's facturación, a mortgage or
 * contribuciones cuota, the month a gastos comunes statement bills, a declared payment's own text.
 */
export type UpcomingPaymentDetail =
  | { kind: "billing_month"; month: string }
  | { kind: "cuota"; n: number; count: number | null }
  | { kind: "bill_month"; month: string }
  | { kind: "text"; text: string };

export type UpcomingPaymentItem = {
  key: string;
  kind: UpcomingPaymentKind;
  /** What the row names: the card, the place a mortgage or bill is for, or the declared payment's name. */
  name: string;
  due_iso: string;
  /** «by» a deadline, or «on» the day to pay (the mortgage: its best day for the UF). */
  due_kind: "by" | "on";
  /** What counts in the month's total (the mortgage: its minimum cuota). */
  amount_clp: number;
  /** The mortgage's maximum cuota; null for everything else. */
  amount_max_clp: number | null;
  /** No document states the amount yet (projected, last period's, or declared). */
  estimated: boolean;
  overdue: boolean;
  /** Mortgage cuota number; contribuciones cuota 1–4. */
  cuota: number | null;
  /** Contribuciones: 4; null otherwise. */
  cuota_count: number | null;
  /** Gastos comunes: the month the statement bills (YYYY-MM). */
  bill_month: string | null;
  /** A card's facturación, as the card panel showed it. */
  card: CcUpcomingPaymentRow | null;
  /** What the occurrence is beyond its name, shown on hover; null = nothing more to say. */
  detail: UpcomingPaymentDetail | null;
  /** A declared payment (`recurring_payments`, manual). */
  wip: boolean;
  /** Where the payment's label links: the card's or mortgage's account page, the place's real-estate expenses; null for a declared payment. */
  route_path: string | null;
};

/**
 * How close a payment's last day is: «today» on its due day, «tomorrow» the day before (Chile
 * day); null otherwise, an overdue one included (it reads in red already).
 */
export type UpcomingPaymentDueSoon = "today" | "tomorrow" | null;

export function upcomingPaymentDueSoon(item: Pick<UpcomingPaymentItem, "due_iso" | "overdue">, todayYmd: string): UpcomingPaymentDueSoon {
  if (item.overdue) return null;
  if (item.due_iso === todayYmd) return "today";
  if (item.due_iso === addDaysIso(todayYmd, 1)) return "tomorrow";
  return null;
}

export type UpcomingPaymentsMonth = {
  pay_month: string;
  total_clp: number;
  /** Overdue first, then by due date. */
  items: (UpcomingPaymentItem & { due_soon: UpcomingPaymentDueSoon })[];
};

/** An automatic declared payment's occurrence (charged to the card; never listed in `months`). */
export type AutomaticRecurringOccurrence = {
  key: string;
  recurring_payment_id: number;
  name: string;
  detail: string | null;
  frequency: RecurringFrequency;
  due_iso: string;
  status: RecurringStatus;
  amount_clp: number;
  estimated: boolean;
  /** The line that paid it; null while unpaid. */
  matched_line: { ref: string; purchase_on: string; merchant: string | null; amount_clp: number } | null;
};

export type UpcomingPaymentsBlock = {
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["upcoming_payments"];
  /** Pay months with something due, oldest first, within the horizon; empty = nothing to show. */
  months: UpcomingPaymentsMonth[];
  /** Automatic declared payments in their window, every occurrence with its status (not listed in `months`). */
  automatic_recurring: AutomaticRecurringOccurrence[];
};

type ItemDraft = Omit<UpcomingPaymentItem, "amount_max_clp" | "cuota" | "cuota_count" | "bill_month" | "card" | "detail" | "wip" | "route_path"> &
  Partial<Pick<UpcomingPaymentItem, "amount_max_clp" | "cuota" | "cuota_count" | "bill_month" | "card" | "detail" | "wip" | "route_path">>;

function item(d: ItemDraft): UpcomingPaymentItem {
  return {
    amount_max_clp: null,
    cuota: null,
    cuota_count: null,
    bill_month: null,
    card: null,
    detail: null,
    wip: false,
    route_path: null,
    ...d,
  };
}


// ---------------------------------------------------------------------------------------------
// Grouping

/** Overdue items fall in the current month; the rest by their due month; outside the horizon dropped. */
export function groupUpcomingByMonth(
  items: readonly UpcomingPaymentItem[],
  todayYmd: string,
  horizonMonths: number = UPCOMING_PAYMENTS_HORIZON_MONTHS
): UpcomingPaymentsMonth[] {
  const first = todayYmd.slice(0, 7);
  const last = addCalendarMonths(first, horizonMonths - 1);
  const byMonth = new Map<string, UpcomingPaymentsMonth>();
  for (const it of items) {
    const payMonth = it.overdue ? first : it.due_iso.slice(0, 7);
    if (payMonth < first || payMonth > last) continue;
    const month = byMonth.get(payMonth) ?? { pay_month: payMonth, total_clp: 0, items: [] };
    month.total_clp += it.amount_clp;
    month.items.push({ ...it, due_soon: upcomingPaymentDueSoon(it, todayYmd) });
    byMonth.set(payMonth, month);
  }
  const months = [...byMonth.values()].sort((a, b) => a.pay_month.localeCompare(b.pay_month));
  for (const m of months) {
    m.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due_iso.localeCompare(b.due_iso));
  }
  return months;
}

// ---------------------------------------------------------------------------------------------
// Mortgage

export type MortgageUpcomingInput = {
  /** The loan the cuotas are of (keys its items: two loans number their cuotas alike). */
  loanAccountId: number;
  /** The tracked place whose property the mortgage pays for, else the mortgage account's name. */
  name: string;
  /** The mortgage account's page. */
  route_path: string;
  /** The next cuota to pay (the last one in the ledger + 1) and its schedule day (the 11th). */
  nextCuota: number;
  nextScheduleYmd: string;
  /** Projected minimum (amortization at the remaining balance) and the bank's posted máxima, in UF. */
  minUf: number;
  maxUf: number;
  /** The lender's quote of `nextCuota` (`mortgage_lender_quotes`): its figures replace the projection for that cuota only. */
  quote: { minUf: number; maxUf: number } | null;
  /** The UF module's best pay date for the cuota of `bestPay.month` (null = the 11th is best). */
  bestPay: { month: string; date: string } | null;
};

/**
 * The mortgage's cuotas from the next unpaid one through the horizon: each on its best day to pay
 * (the 11th unless the UF module found a later, cheaper one), its minimum and maximum in pesos at
 * that day's UF (projected past the last published one). The next cuota takes the lender's quote
 * when one is stored (not estimated); the rest are projections. Overdue past its window (10th of
 * the next month).
 */
export function mortgageUpcomingItems(
  input: MortgageUpcomingInput,
  todayYmd: string,
  horizonEndMonth: string,
  ufOn: (ymd: string) => number
): UpcomingPaymentItem[] {
  const out: UpcomingPaymentItem[] = [];
  let cuota = input.nextCuota;
  let schedule = input.nextScheduleYmd;
  while (schedule.slice(0, 7) <= horizonEndMonth) {
    const month = schedule.slice(0, 7);
    const due = input.bestPay && input.bestPay.month === month ? input.bestPay.date : schedule;
    const windowEnd = dayInMonth(addCalendarMonths(month, 1), MORTGAGE_WINDOW_END_DAY);
    const uf = ufOn(due);
    const quoted = cuota === input.nextCuota ? input.quote : null;
    const minUf = quoted?.minUf ?? input.minUf;
    const maxUf = quoted?.maxUf ?? input.maxUf;
    out.push(
      item({
        key: `mortgage|${input.loanAccountId}|${cuota}`,
        kind: "mortgage",
        name: input.name,
        detail: { kind: "cuota", n: cuota, count: null },
        route_path: input.route_path,
        due_iso: due,
        due_kind: "on",
        amount_clp: Math.round(minUf * uf),
        amount_max_clp: Math.round(maxUf * uf),
        estimated: quoted == null,
        overdue: todayYmd > windowEnd,
        cuota,
      })
    );
    cuota += 1;
    schedule = `${addCalendarMonths(month, 1)}-${schedule.slice(8, 10)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gastos comunes

/** A tracked place (`expense_accounts`) and its real-estate expenses page. */
export type UpcomingPlace = { id: number; label: string; route_path: string };

/** The real-estate expenses page of one place. */
export function realEstatePlaceRoutePath(slug: string): string {
  return `/flows/expenses/real_estate/${slug}`;
}

export type HoaStatement = { bill_month: string; due_on: string; amount: number; settled: boolean };

/**
 * A place's gastos comunes month by month, without waiting for the statement: the bill of month
 * B is paid in month B + 1, by the day of the month its latest statement named. With the
 * statement on file its amount and due date are the statement's; without it, the latest
 * statement's amount (estimated). Paid when a gastos comunes bill row covers the month or its
 * statement is settled.
 */
export function hoaUpcomingItems(
  place: UpcomingPlace,
  statements: readonly HoaStatement[],
  paidBillMonths: ReadonlySet<string>,
  todayYmd: string,
  horizonEndMonth: string
): UpcomingPaymentItem[] {
  if (statements.length === 0) return [];
  const sorted = [...statements].sort((a, b) => a.bill_month.localeCompare(b.bill_month));
  const latest = sorted[sorted.length - 1]!;
  const dueDay = Number(latest.due_on.slice(8, 10));
  const byMonth = new Map(sorted.map((s) => [s.bill_month, s]));
  const out: UpcomingPaymentItem[] = [];
  const current = todayYmd.slice(0, 7);
  // From the month the latest statement bills (its pay month may still be open) on.
  for (let billMonth = latest.bill_month; addCalendarMonths(billMonth, 1) <= horizonEndMonth; billMonth = addCalendarMonths(billMonth, 1)) {
    const payMonth = addCalendarMonths(billMonth, 1);
    const statement = byMonth.get(billMonth);
    if (paidBillMonths.has(billMonth) || statement?.settled) continue;
    const due = statement?.due_on ?? dayInMonth(payMonth, dueDay);
    if (!statement && payMonth < current) continue;
    out.push(
      item({
        key: `hoa|${place.id}|${billMonth}`,
        kind: "hoa",
        name: place.label,
        route_path: place.route_path,
        due_iso: due,
        due_kind: "by",
        amount_clp: statement?.amount ?? latest.amount,
        estimated: !statement,
        overdue: due < todayYmd,
        bill_month: billMonth,
        detail: { kind: "bill_month", month: billMonth },
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Contribuciones

export type ContribucionesPayment = { spent_on: string; amount: number };

/**
 * An owned property's contribuciones: four cuotas a year, due on the last day of April, June,
 * September and November. A year's cuotas are paid in order, so the year's bill rows say how many
 * are paid. Once the first is paid its amount holds for the year's other three; before that, last
 * year's same cuota readjusted by the UF (estimated). Nothing is shown for a property with no
 * contribuciones on record.
 */
export function contribucionesUpcomingItems(
  place: UpcomingPlace,
  payments: readonly ContribucionesPayment[],
  todayYmd: string,
  horizonEndMonth: string,
  ufOn: (ymd: string) => number
): UpcomingPaymentItem[] {
  const out: UpcomingPaymentItem[] = [];
  const byYear = new Map<number, ContribucionesPayment[]>();
  for (const p of [...payments].sort((a, b) => a.spent_on.localeCompare(b.spent_on))) {
    const y = Number(p.spent_on.slice(0, 4));
    byYear.set(y, [...(byYear.get(y) ?? []), p]);
  }
  const thisYear = Number(todayYmd.slice(0, 4));
  const lastYear = Number(horizonEndMonth.slice(0, 4));
  for (let year = thisYear; year <= lastYear; year += 1) {
    const paid = byYear.get(year) ?? [];
    const previous = byYear.get(year - 1) ?? [];
    CONTRIBUCIONES_DUE_MONTHS.forEach((month, i) => {
      const cuota = i + 1;
      if (cuota <= paid.length) return;
      const dueMonth = `${year}-${String(month).padStart(2, "0")}`;
      if (dueMonth > horizonEndMonth) return;
      const due = dayInMonth(dueMonth, 31);
      let amount: number;
      let estimated: boolean;
      if (paid.length > 0) {
        amount = paid[0]!.amount;
        estimated = false;
      } else {
        const base = previous[i] ?? previous[0];
        if (!base) return;
        amount = Math.round(base.amount * (ufOn(due) / ufOn(base.spent_on)));
        estimated = true;
      }
      out.push(
        item({
          key: `contribuciones|${place.id}|${year}|${cuota}`,
          kind: "contribuciones",
          name: place.label,
          route_path: place.route_path,
          due_iso: due,
          due_kind: "by",
          amount_clp: amount,
          estimated,
          overdue: due < todayYmd,
          cuota,
          cuota_count: CONTRIBUCIONES_DUE_MONTHS.length,
          detail: { kind: "cuota", n: cuota, count: CONTRIBUCIONES_DUE_MONTHS.length },
        })
      );
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Assembly from the database


/** Every loan's input: one per property whose ledger has a next cuota (ascending by property id). */
function mortgageInputs(todayYmd: string): MortgageUpcomingInput[] {
  return loadAllDeptoLedgers().flatMap(({ propertyAccountId, loanAccountId, rows }) => {
    if (loanAccountId == null) return [];
    const input = mortgageInput(todayYmd, propertyAccountId, loanAccountId, rows);
    return input ? [input] : [];
  });
}

function mortgageInput(
  todayYmd: string,
  propertyAccountId: number,
  mortgageId: number,
  ledger: DeptoMortgageSheetRow[]
): MortgageUpcomingInput | null {
  if (ledger.length === 0) return null;
  const next = buildDeptoPaymentScenarioRows(ledger).find((r) => r.is_next_payment);
  if (!next) return null;
  const nextCuota = numericCuota(next.cuota);
  if (nextCuota == null) throw new Error(`Mortgage: next cuota «${next.cuota}» is not a number`);
  const firstSchedule = firstMortgageScheduleYmd(ledger);
  const numeric = ledger.map((r) => numericCuota(r.cuota)).filter((n): n is number => n != null);
  if (!firstSchedule || numeric.length === 0) return null;
  const nextScheduleYmd = mortgageScheduleYmdForCuota(firstSchedule, Math.min(...numeric), nextCuota);
  if (!nextScheduleYmd) throw new Error(`Mortgage: no schedule day for cuota ${nextCuota}`);
  const minUf = next.min_payment_uf;
  const maxUf = next.scenarios.find((s) => s.term === "max")?.payment_uf ?? null;
  if (minUf == null || maxUf == null) throw new Error(`Mortgage: cuota ${nextCuota} has no projected minimum or maximum`);
  const quoteOfNext = nextCuotaQuoteForLoan(mortgageId, ledger);
  const reminder = buildMortgageUfReminder(todayYmd, mortgageId);
  const bestPay =
    reminder.show && reminder.cycle_month && reminder.best_pay_date
      ? { month: reminder.cycle_month, date: reminder.best_pay_date }
      : null;
  const account = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(mortgageId) as { name: string } | undefined;
  if (!account) throw new Error(`Mortgage account ${mortgageId} not found`);
  const place = db
    .prepare(`SELECT label FROM expense_accounts WHERE property_account_id = ? ORDER BY active_to IS NOT NULL, id LIMIT 1`)
    .get(propertyAccountId) as { label: string } | undefined;
  return {
    loanAccountId: mortgageId,
    name: place?.label ?? account.name,
    route_path: accountRoutePath(mortgageId),
    nextCuota,
    nextScheduleYmd,
    minUf,
    maxUf,
    quote: quoteOfNext ? { minUf: quoteOfNext.min_uf, maxUf: quoteOfNext.max_uf } : null,
    bestPay,
  };
}

type PlaceRow = { id: number; label: string; slug: string };

function upcomingPlace(row: PlaceRow): UpcomingPlace {
  return { id: row.id, label: row.label, route_path: realEstatePlaceRoutePath(row.slug) };
}

/** An account's detail page. */
function accountRoutePath(accountId: number): string {
  return `/account/${accountId}`;
}

function hoaPlaces(): { place: UpcomingPlace; statements: HoaStatement[]; paid: Set<string> }[] {
  const mapping = db
    .prepare(
      `SELECT u.provider, u.service_account, a.id, a.label, a.slug
       FROM utility_service_accounts u JOIN expense_accounts a ON a.id = u.expense_account_id
       WHERE a.active_to IS NULL`
    )
    .all() as { provider: string; service_account: string; id: number; label: string; slug: string }[];
  const placeFor = new Map(
    mapping.map((m) => [`${m.provider}|${normalizeCheckDigitId(m.service_account)}`, upcomingPlace(m)])
  );
  const bills = db
    .prepare(
      `SELECT provider, service_account, issued_on, due_on, amount, period_to, settled_at
       FROM utility_bills WHERE service = 'hoa'`
    )
    .all() as { provider: string; service_account: string; issued_on: string; due_on: string; amount: number; period_to: string | null; settled_at: string | null }[];
  const byPlace = new Map<number, { place: UpcomingPlace; statements: HoaStatement[]; paid: Set<string> }>();
  for (const b of bills) {
    const place = placeFor.get(`${b.provider}|${normalizeCheckDigitId(b.service_account)}`);
    if (!place) continue;
    const entry = byPlace.get(place.id) ?? { place, statements: [], paid: new Set<string>() };
    entry.statements.push({
      bill_month: utilityBillMonth({ period_to: b.period_to, issued_on: b.issued_on }),
      due_on: b.due_on,
      amount: b.amount,
      settled: b.settled_at != null,
    });
    byPlace.set(place.id, entry);
  }
  const covered = db.prepare(
    `SELECT spent_on, months_covered FROM expense_entries WHERE expense_account_id = ? AND category = 'gastos_comunes'`
  );
  for (const entry of byPlace.values()) {
    for (const r of covered.all(entry.place.id) as { spent_on: string; months_covered: number }[]) {
      const last = r.spent_on.slice(0, 7);
      for (let k = 0; k < (r.months_covered ?? 1); k += 1) entry.paid.add(addCalendarMonths(last, -k));
    }
  }
  return [...byPlace.values()];
}

function ownedPlaces(): { place: UpcomingPlace; payments: ContribucionesPayment[] }[] {
  const places = db
    .prepare(`SELECT id, label, slug FROM expense_accounts WHERE property_account_id IS NOT NULL AND active_to IS NULL`)
    .all() as PlaceRow[];
  const payments = db.prepare(
    `SELECT spent_on, amount_clp AS amount FROM expense_entries WHERE expense_account_id = ? AND category = 'contribuciones'`
  );
  return places.map((row) => ({ place: upcomingPlace(row), payments: payments.all(row.id) as ContribucionesPayment[] }));
}

// ---------------------------------------------------------------------------------------------
// Declared recurring payments (`recurring_payments`, matched in `recurringPaymentMatch.ts`)

export class RecurringPaymentInputError extends Error {}

function fail(message: string): never {
  throw new RecurringPaymentInputError(message);
}

const insertRecurringStmt = db.prepare(
  `INSERT INTO recurring_payments (name, detail, manual, frequency, due_month, due_day, amount, currency,
                                   match_days_before, match_days_after, amount_tolerance_pct)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertPatternStmt = db.prepare(`INSERT INTO recurring_payment_patterns (recurring_payment_id, pattern) VALUES (?, ?)`);
const deletePatternsStmt = db.prepare(`DELETE FROM recurring_payment_patterns WHERE recurring_payment_id = ?`);
const deleteRecurringStmt = db.prepare(`DELETE FROM recurring_payments WHERE id = ?`);


/**
 * The expense lines the matcher reads, each named by its source and statement line id, at their
 * pesos: a declared payment is stated in pesos or UF, and a dollar charge (a subscription billed
 * in dollars) pays it at the pesos its card line shows.
 */
function recurringLines(): RecurringLine[] {
  return loadGastosLinesForRealEstateMatching().map((l) => toRecurringLine({ ...l, amount_clp: linePesos(l) }));
}

/** A manual occurrence as a «Próximos pagos» row (its own name; the detail on hover). */
function recurringItem(o: RecurringOccurrence): UpcomingPaymentItem {
  return item({
    key: `recurring|${o.entry.id}|${o.due_iso}`,
    kind: "recurring",
    name: o.entry.name,
    detail: o.entry.detail == null ? null : { kind: "text", text: o.entry.detail },
    due_iso: o.due_iso,
    due_kind: "by",
    amount_clp: o.amount_clp,
    estimated: o.estimated,
    overdue: o.status === "overdue",
    wip: true,
  });
}

function automaticRecurringItem(o: RecurringOccurrence): AutomaticRecurringOccurrence {
  return {
    key: `recurring|${o.entry.id}|${o.due_iso}`,
    recurring_payment_id: o.entry.id,
    name: o.entry.name,
    detail: o.entry.detail,
    frequency: o.entry.frequency,
    due_iso: o.due_iso,
    status: o.status,
    amount_clp: o.amount_clp,
    estimated: o.estimated,
    matched_line: o.matched,
  };
}

/** Declared payments: the manual unpaid occurrences as «Próximos pagos» items, the automatic ones apart. */
function recurringSection(
  todayYmd: string,
  horizonEndYmd: string,
  uf: { ufOn: (ymd: string) => number; knownThrough: string }
): { items: UpcomingPaymentItem[]; automatic: AutomaticRecurringOccurrence[] } {
  const entries = listRecurringPayments();
  if (entries.length === 0) return { items: [], automatic: [] };
  const occurrences = matchRecurringPayments({
    entries,
    lines: recurringLines(),
    todayYmd,
    horizonEndYmd,
    ufOn: uf.ufOn,
    ufKnownThrough: uf.knownThrough,
  });
  const items: UpcomingPaymentItem[] = [];
  const automatic: AutomaticRecurringOccurrence[] = [];
  for (const o of occurrences) {
    if (!o.exposed) continue;
    if (o.entry.manual) {
      if (o.status === "overdue" || o.status === "upcoming") items.push(recurringItem(o));
    } else {
      automatic.push(automaticRecurringItem(o));
    }
  }
  return { items, automatic };
}

/** The dashboard's «Próximos pagos»: every source's items, grouped by pay month within the horizon. */
export function buildUpcomingPayments(todayYmd: string = chileCalendarTodayYmd()): UpcomingPaymentsBlock {
  const horizonEnd = addCalendarMonths(todayYmd.slice(0, 7), UPCOMING_PAYMENTS_HORIZON_MONTHS - 1);
  const uf = ufProjector();
  const items: UpcomingPaymentItem[] = [];

  for (const m of buildDashboardCcUpcomingPayments().months) {
    for (const p of m.payments) {
      items.push(
        item({
          key: `card|${p.account_id}|${p.row.billing_month}`,
          kind: "card",
          name: p.name,
          route_path: accountRoutePath(p.account_id),
          due_iso: p.row.pay_by_iso,
          due_kind: "by",
          amount_clp: p.row.amount_clp,
          // A card's «≈» is its derived pay-by (`card.pay_by_source`), drawn by the card row itself.
          estimated: false,
          overdue: p.row.overdue,
          card: p.row,
          detail: { kind: "billing_month", month: p.row.billing_month },
        })
      );
    }
  }

  for (const mortgage of mortgageInputs(todayYmd)) {
    items.push(...mortgageUpcomingItems(mortgage, todayYmd, horizonEnd, uf.ufOn));
  }

  for (const h of hoaPlaces()) items.push(...hoaUpcomingItems(h.place, h.statements, h.paid, todayYmd, horizonEnd));

  for (const o of ownedPlaces()) items.push(...contribucionesUpcomingItems(o.place, o.payments, todayYmd, horizonEnd, uf.ufOn));

  const recurring = recurringSection(todayYmd, dayInMonth(horizonEnd, 31), uf);
  items.push(...recurring.items);

  return {
    schema_version: DTO_SCHEMA_VERSIONS.upcoming_payments,
    months: groupUpcomingByMonth(items, todayYmd),
    automatic_recurring: recurring.automatic,
  };
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string") fail(`${key} must be text`);
  const t = v.trim();
  if (t === "") fail(`${key} is required`);
  return t;
}

function optionalText(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v == null) return null;
  if (typeof v !== "string") fail(`${key} must be text`);
  const t = v.trim();
  return t === "" ? null : t;
}

function integerInRange(body: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number {
  const v = body[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${key} must be a whole number ${min}–${max}`);
  return v;
}

/**
 * Declares a payment (`recurring_payments` + its patterns). Throws `RecurringPaymentInputError`
 * with the reason on any field out of range, so the route answers 400. Yearly entries need their
 * due month; monthly ones store none. CLP amounts are whole pesos, UF amounts any positive figure.
 */
export function createRecurringPayment(body: Record<string, unknown>): RecurringEntry {
  const name = requiredText(body, "name");
  const detail = optionalText(body, "detail");
  const manual = body.manual === undefined ? true : body.manual;
  if (typeof manual !== "boolean") fail("manual must be true or false");
  const frequency = body.frequency === undefined ? "yearly" : body.frequency;
  if (frequency !== "yearly" && frequency !== "monthly") fail("frequency must be yearly or monthly");
  const currency = body.currency === undefined ? "clp" : body.currency;
  if (currency !== "clp" && currency !== "uf") fail("currency must be clp or uf");
  const dueDay = integerInRange(body, "due_day", 1, 31);
  const dueMonth = frequency === "yearly" ? integerInRange(body, "due_month", 1, 12) : null;
  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) fail("amount must be a positive number");
  if (currency === "clp" && !Number.isInteger(amount)) fail("amount must be whole pesos for a CLP payment");
  const rawPatterns = body.patterns;
  if (!Array.isArray(rawPatterns)) fail("patterns must be a list of merchant patterns");
  const patterns: string[] = [];
  for (const p of rawPatterns) {
    if (typeof p !== "string") fail("patterns must be text");
    const t = p.trim();
    if (t !== "" && !patterns.includes(t)) patterns.push(t);
  }
  if (patterns.length === 0) fail("at least one merchant pattern is required");
  const matchBefore = integerInRange(body, "match_days_before", 0, 60, 14);
  const matchAfter = integerInRange(body, "match_days_after", 0, 60, 7);
  let tolerance: number | null = null;
  if (body.amount_tolerance_pct != null) {
    const t = body.amount_tolerance_pct;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 100) fail("amount_tolerance_pct must be above 0 and at most 100");
    tolerance = t;
  }
  const id = db.transaction(() => {
    const newId = Number(
      insertRecurringStmt.run(
        name,
        detail,
        manual ? 1 : 0,
        frequency,
        dueMonth,
        dueDay,
        amount,
        currency,
        matchBefore,
        matchAfter,
        tolerance
      ).lastInsertRowid
    );
    for (const p of patterns) insertPatternStmt.run(newId, p);
    return newId;
  })();
  const row = listRecurringPayments().find((r) => r.id === id);
  if (!row) throw new Error(`recurring payment ${id} not found after insert`);
  return row;
}

export function deleteRecurringPayment(id: number): boolean {
  return db.transaction(() => {
    deletePatternsStmt.run(id);
    return deleteRecurringStmt.run(id).changes > 0;
  })();
}
