/**
 * «Próximos pagos» on the home dashboard: everything due in the coming months, grouped by the
 * month it is due — the credit cards' facturaciones (`dashboardCcUpcomingPayments.ts`), the
 * mortgage cuota, each place's gastos comunes, each owned property's contribuciones and the
 * payments the user declared (`recurring_payments`, WIP). An item leaves the list once it is
 * paid; an unpaid one past its due date is overdue and counts in the current month.
 *
 * The server sends `UPCOMING_PAYMENTS_HORIZON_MONTHS` months from the current one; the panel shows
 * the first two and the rest on «Show more». Amounts a document does not state yet are estimates
 * (`estimated`, «≈»), future UF at the last twelve months' growth (`projectedUfClp`).
 */
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { buildDashboardCcUpcomingPayments, type CcUpcomingPaymentRow } from "./dashboardCcUpcomingPayments.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import {
  buildDeptoPaymentScenarioRows,
  firstMortgageScheduleYmd,
  mortgageScheduleYmdForCuota,
} from "./mortgageScenarioPayments.js";
import { buildMortgageUfReminder } from "./mortgageUfReminder.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import { deptoMortgageAccountId, deptoPropertyAccountId } from "./mortgagePaymentCreate.js";
import { normalizeServiceAccount, utilityBillMonth } from "./utilityBillsApply.js";
import { loadGastosLinesForRealEstateMatching } from "./realEstateExpenseMatching.js";

/** Months the block covers, the current one included («Show more» shows them all). */
export const UPCOMING_PAYMENTS_HORIZON_MONTHS = 6;

/** Day-of-month window of a mortgage cuota: payable from the 11th through the 10th of the next month. */
const MORTGAGE_WINDOW_END_DAY = 10;

/** Contribuciones cuotas: due on the last day of April, June, September and November (Tesorería). */
export const CONTRIBUCIONES_DUE_MONTHS = [4, 6, 9, 11] as const;

export type UpcomingPaymentKind = "card" | "mortgage" | "hoa" | "contribuciones" | "recurring";

export type UpcomingPaymentItem = {
  key: string;
  kind: UpcomingPaymentKind;
  /** The card, the mortgage account, the place, or the declared payment's name. */
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
  /** The tracked place a mortgage pays for (its property's expense place); null otherwise. */
  place_label: string | null;
  /** A declared payment (the WIP table). */
  wip: boolean;
  /** Where the payment's label links: the card's or mortgage's account page, the place's real-estate expenses; null for a declared payment. */
  route_path: string | null;
};

export type UpcomingPaymentsMonth = {
  pay_month: string;
  total_clp: number;
  /** Overdue first, then by due date. */
  items: UpcomingPaymentItem[];
};

export type UpcomingPaymentsBlock = {
  /** Pay months with something due, oldest first, within the horizon; empty = nothing to show. */
  months: UpcomingPaymentsMonth[];
};

type ItemDraft = Omit<UpcomingPaymentItem, "amount_max_clp" | "cuota" | "cuota_count" | "bill_month" | "card" | "place_label" | "wip" | "route_path"> &
  Partial<Pick<UpcomingPaymentItem, "amount_max_clp" | "cuota" | "cuota_count" | "bill_month" | "card" | "place_label" | "wip" | "route_path">>;

function item(d: ItemDraft): UpcomingPaymentItem {
  return {
    amount_max_clp: null,
    cuota: null,
    cuota_count: null,
    bill_month: null,
    card: null,
    place_label: null,
    wip: false,
    route_path: null,
    ...d,
  };
}

function lastDayOfMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `YYYY-MM-DD` for a day of a month, clamped to the month's length. */
export function dayInMonth(ym: string, day: number): string {
  return `${ym}-${String(Math.min(day, lastDayOfMonth(ym))).padStart(2, "0")}`;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// UF ahead of its publication

export type UfLookup = (ymd: string) => { date: string; clp_per_uf: number } | null;

/**
 * The UF on a day: the published value on or before it, or — past the last published day — the
 * last value grown at the last twelve months' rate (a rough estimate the user asked for). Throws
 * when the series has no year of history to take the rate from.
 */
export function projectedUfClp(ymd: string, latest: { date: string; clp_per_uf: number }, lookup: UfLookup): number {
  if (ymd <= latest.date) {
    const row = lookup(ymd);
    if (!row) throw new Error(`No UF on or before ${ymd}`);
    return row.clp_per_uf;
  }
  const yearAgo = lookup(addDays(latest.date, -365));
  if (!yearAgo) throw new Error(`No UF a year before ${latest.date} to project from`);
  const growth = latest.clp_per_uf / yearAgo.clp_per_uf;
  return latest.clp_per_uf * growth ** (daysBetween(latest.date, ymd) / 365);
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
    month.items.push(it);
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
  name: string;
  /** The tracked place whose property the mortgage pays for; null when none is tracked. */
  place_label: string | null;
  /** The mortgage account's page. */
  route_path: string;
  /** The next cuota to pay (the last one in the ledger + 1) and its schedule day (the 11th). */
  nextCuota: number;
  nextScheduleYmd: string;
  /** Projected minimum (amortization at the remaining balance) and the bank's posted máxima, in UF. */
  minUf: number;
  maxUf: number;
  /** The UF module's best pay date for the cuota of `bestPayMonth` (null = the 11th is best). */
  bestPay: { month: string; date: string } | null;
};

/**
 * The mortgage's cuotas from the next unpaid one through the horizon: each on its best day to pay
 * (the 11th unless the UF module found a later, cheaper one), its minimum and maximum in pesos at
 * that day's UF (projected past the last published one). Overdue past its window (10th of the
 * next month).
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
    out.push(
      item({
        key: `mortgage|${cuota}`,
        kind: "mortgage",
        name: input.name,
        place_label: input.place_label,
        route_path: input.route_path,
        due_iso: due,
        due_kind: "on",
        amount_clp: Math.round(input.minUf * uf),
        amount_max_clp: Math.round(input.maxUf * uf),
        estimated: true,
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
        })
      );
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Declared recurring payments (WIP)

export type RecurringPayment = {
  id: number;
  name: string;
  due_month: number;
  due_day: number;
  amount_clp: number;
  paid_merchant_pattern: string;
  /** When it was declared (ISO): an occurrence due before then is not asked for. */
  created_at: string;
};

/** Days before a due date a matching charge counts as its payment (an early payment), and after. */
const RECURRING_PAID_WINDOW = { before: 120, after: 31 } as const;

function foldUpper(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/**
 * A declared yearly payment through the horizon (and this year's, if still unpaid past its due
 * date — unless it was due before the payment was declared). Paid when an expense line whose merchant or shown name contains the pattern was bought
 * from `RECURRING_PAID_WINDOW.before` days before the due date to `.after` days past it.
 */
export function recurringUpcomingItems(
  rp: RecurringPayment,
  lines: readonly { purchase_on: string | null; merchant: string | null; display_merchant?: string }[],
  todayYmd: string,
  horizonEndMonth: string
): UpcomingPaymentItem[] {
  const pattern = foldUpper(rp.paid_merchant_pattern.trim());
  const out: UpcomingPaymentItem[] = [];
  const thisYear = Number(todayYmd.slice(0, 4));
  for (let year = thisYear; `${year}-01` <= horizonEndMonth; year += 1) {
    const dueMonth = `${year}-${String(rp.due_month).padStart(2, "0")}`;
    if (dueMonth > horizonEndMonth) continue;
    const due = dayInMonth(dueMonth, rp.due_day);
    if (due < rp.created_at.slice(0, 10)) continue;
    const from = addDays(due, -RECURRING_PAID_WINDOW.before);
    const to = addDays(due, RECURRING_PAID_WINDOW.after);
    const paid = lines.some(
      (l) =>
        l.purchase_on != null &&
        l.purchase_on >= from &&
        l.purchase_on <= to &&
        [l.merchant, l.display_merchant].some((m) => m != null && foldUpper(m).includes(pattern))
    );
    if (paid) continue;
    out.push(
      item({
        key: `recurring|${rp.id}|${year}`,
        kind: "recurring",
        name: rp.name,
        due_iso: due,
        due_kind: "by",
        amount_clp: rp.amount_clp,
        estimated: true,
        overdue: due < todayYmd,
        wip: true,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Assembly from the database

const latestUfStmt = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 1`);
const ufOnOrBeforeStmt = db.prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`);

function ufProjector(): (ymd: string) => number {
  const latest = latestUfStmt.get() as { date: string; clp_per_uf: number } | undefined;
  if (!latest) throw new Error("uf_daily is empty");
  const lookup: UfLookup = (ymd) => (ufOnOrBeforeStmt.get(ymd) as { date: string; clp_per_uf: number } | undefined) ?? null;
  return (ymd) => projectedUfClp(ymd, latest, lookup);
}

function mortgageInput(todayYmd: string): MortgageUpcomingInput | null {
  const ledger = loadDeptoLedgerFromMovements();
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
  const reminder = buildMortgageUfReminder(todayYmd);
  const bestPay =
    reminder.show && reminder.cycle_month && reminder.best_pay_date
      ? { month: reminder.cycle_month, date: reminder.best_pay_date }
      : null;
  const mortgageId = deptoMortgageAccountId();
  const account = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(mortgageId) as { name: string } | undefined;
  if (!account) throw new Error(`Mortgage account ${mortgageId} not found`);
  const place = db
    .prepare(`SELECT label FROM expense_accounts WHERE property_account_id = ? ORDER BY active_to IS NOT NULL, id LIMIT 1`)
    .get(deptoPropertyAccountId()) as { label: string } | undefined;
  return { name: account.name, place_label: place?.label ?? null, route_path: accountRoutePath(mortgageId), nextCuota, nextScheduleYmd, minUf, maxUf, bestPay };
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
    mapping.map((m) => [`${m.provider}|${normalizeServiceAccount(m.service_account)}`, upcomingPlace(m)])
  );
  const bills = db
    .prepare(
      `SELECT provider, service_account, issued_on, due_on, amount, period_to, settled_at
       FROM utility_bills WHERE service = 'hoa'`
    )
    .all() as { provider: string; service_account: string; issued_on: string; due_on: string; amount: number; period_to: string | null; settled_at: string | null }[];
  const byPlace = new Map<number, { place: UpcomingPlace; statements: HoaStatement[]; paid: Set<string> }>();
  for (const b of bills) {
    const place = placeFor.get(`${b.provider}|${normalizeServiceAccount(b.service_account)}`);
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

const recurringStmt = db.prepare(
  `SELECT id, name, due_month, due_day, amount_clp, paid_merchant_pattern, created_at FROM recurring_payments ORDER BY id`
);

export function listRecurringPayments(): RecurringPayment[] {
  return recurringStmt.all() as RecurringPayment[];
}

/** The dashboard's «Próximos pagos»: every source's items, grouped by pay month within the horizon. */
export function buildUpcomingPayments(todayYmd: string = chileCalendarTodayYmd()): UpcomingPaymentsBlock {
  const horizonEnd = addCalendarMonths(todayYmd.slice(0, 7), UPCOMING_PAYMENTS_HORIZON_MONTHS - 1);
  const ufOn = ufProjector();
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
        })
      );
    }
  }

  const mortgage = mortgageInput(todayYmd);
  if (mortgage) items.push(...mortgageUpcomingItems(mortgage, todayYmd, horizonEnd, ufOn));

  for (const h of hoaPlaces()) items.push(...hoaUpcomingItems(h.place, h.statements, h.paid, todayYmd, horizonEnd));

  for (const o of ownedPlaces()) items.push(...contribucionesUpcomingItems(o.place, o.payments, todayYmd, horizonEnd, ufOn));

  const recurring = listRecurringPayments();
  if (recurring.length > 0) {
    const lines = loadGastosLinesForRealEstateMatching();
    for (const rp of recurring) items.push(...recurringUpcomingItems(rp, lines, todayYmd, horizonEnd));
  }

  return {
    months: groupUpcomingByMonth(items, todayYmd),
  };
}

/**
 * Declares a yearly payment (WIP: no screen yet, the endpoints are the way in). Throws with the
 * reason on a field out of range, so the route answers 400.
 */
export function createRecurringPayment(body: Record<string, unknown>): RecurringPayment {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const pattern = typeof body.paid_merchant_pattern === "string" ? body.paid_merchant_pattern.trim() : "";
  const dueMonth = Number(body.due_month);
  const dueDay = Number(body.due_day);
  const amount = Number(body.amount_clp);
  if (!name) throw new RecurringPaymentInputError("name is required");
  if (!pattern) throw new RecurringPaymentInputError("paid_merchant_pattern is required");
  if (!Number.isInteger(dueMonth) || dueMonth < 1 || dueMonth > 12) throw new RecurringPaymentInputError("due_month must be 1–12");
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new RecurringPaymentInputError("due_day must be 1–31");
  if (!Number.isInteger(amount) || amount <= 0) throw new RecurringPaymentInputError("amount_clp must be a positive integer");
  const id = Number(
    db
      .prepare(
        `INSERT INTO recurring_payments (name, due_month, due_day, amount_clp, paid_merchant_pattern) VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, dueMonth, dueDay, amount, pattern).lastInsertRowid
  );
  const row = recurringStmt.all().find((r) => (r as RecurringPayment).id === id) as RecurringPayment | undefined;
  if (!row) throw new Error(`recurring payment ${id} not found after insert`);
  return row;
}

export function deleteRecurringPayment(id: number): boolean {
  return db.prepare(`DELETE FROM recurring_payments WHERE id = ?`).run(id).changes > 0;
}

export class RecurringPaymentInputError extends Error {}
