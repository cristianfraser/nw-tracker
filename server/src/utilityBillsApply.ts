/**
 * Utility bills (`utility.bill`): an electricity, gas, water or internet bill, or a building's
 * gastos comunes statement, read from the provider's mail becomes the real-estate page's bill row
 * for its place — once, and only once the card or checking charge that paid it is in. Nothing that
 * has not happened appears on the page.
 *
 * Each bill is stored once (`utility_bills`, keyed by provider + bill number); a resend that states
 * anything else is a conflict and stores nothing — except a period one send leaves out (ENEL's is
 * read from the bill before it, outside a short fetch window), which a send that has it fills in.
 * Every bill not settled yet is followed on each
 * apply:
 *  - its supply's place comes from `utility_service_accounts` (provider + the account number as
 *    printed, compared without punctuation or leading zeros). An unmapped supply writes nothing.
 *  - its charge (`pickUtilityBillCharge`) is the one whole purchase among the lines the page pairs
 *    bills with (`loadGastosLinesForRealEstateMatching`) of exactly the bill's pesos, whose merchant
 *    is the kind's (`merchantMatchesExpectation`), dated from the issue day through the end of its
 *    window (`chargeWindowEnd`: due + 20 days; a gastos comunes statement, paid by transfer later
 *    in the month, its issue day + 35). A transfer whose mail names its counterparty must be paying
 *    someone else than the client's own accounts; among several, those whose counterparty is the
 *    place's are kept. Several → ambiguous; none → waiting, and overdue 5 days past the window.
 *  - a charge no bill row holds yet → a bill row created from it (`assignPurchaseToRealEstateExpense`)
 *    in the bill's month (`utilityBillMonth`) with the consumption; a charge already filed under a
 *    bill by hand → that bill's consumption filled when empty. A bill row of another place, kind or
 *    amount, or a different consumption already stored, is a conflict: never overwritten.
 * A bill that created or filled its row is settled and never followed again (a row deleted by hand
 * afterwards is not written back).
 *
 * A place that receives gastos comunes statements also has its payments to the building checked
 * the other way (`unbilledHoaPayments`): a gastos comunes payment no bill row holds, made since its
 * first statement and more than `UNBILLED_HOA_PAYMENT_GRACE_DAYS` ago, is listed — the statement
 * for its month never arrived. Nothing is written for it.
 */
import { createHash } from "node:crypto";
import type {
  UtilityBill,
  UtilityBillApplyDetails,
  UtilityBillOutcome,
  UtilityBillPayload,
  UtilityService,
} from "nw-tracker-contracts";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import {
  assignPurchaseToRealEstateExpense,
  loadExpectationById,
  loadGastosLinesForRealEstateMatching,
  updateRealEstateExpenseConsumption,
  updateRealEstateExpenseMonthsCovered,
} from "./realEstateExpenseMatching.js";
import { merchantMatchesExpectation, type RealEstateBillKind } from "./realEstateExpenseMerchants.js";

/** How long after its due day a bill's charge may still be dated. */
export const UTILITY_BILL_CHARGE_GRACE_DAYS = 20;
/** A gastos comunes statement's charge (a transfer later in the month) may be dated this long after its issue day. */
export const HOA_CHARGE_WINDOW_DAYS = 35;
/** Past its charge window by this many days with no charge, a bill is reported overdue. */
export const UTILITY_BILL_OVERDUE_DAYS = 5;
/** A gastos comunes payment with no statement is reported once this old. */
export const UNBILLED_HOA_PAYMENT_GRACE_DAYS = 10;

/** The real-estate bill kind each service is filed under. */
export const UTILITY_SERVICE_KIND: Record<UtilityService, RealEstateBillKind> = {
  electricity: "electricidad",
  gas: "gas",
  water: "water",
  internet: "internet",
  hoa: "gastos_comunes",
};

/** An account number as printed, for comparison: digits and the check letter, no leading zeros. */
export function normalizeServiceAccount(raw: string): string {
  return raw.replace(/[^0-9kK]/g, "").toUpperCase().replace(/^0+/, "");
}

/**
 * The bill's month on the page: the month it charges consumption for. Bills are issued just after
 * their period closes — ENEL's monthly period closes on the 1st–5th and the bill goes out a few days
 * later; Metrogas's two-month period closes on the 23rd–25th and the bill goes out that week — so it
 * is the month of the period's last day when that day falls in the month's second half, else the
 * month before (the period's last day, or the issue day when the period is not printed). The charge
 * then lands in that month's next month (+1), inside the page's +0..+2 window.
 */
export function utilityBillMonth(b: Pick<UtilityBill, "period_to" | "issued_on">): string {
  const day = b.period_to ?? b.issued_on;
  const ym = day.slice(0, 7);
  return Number(day.slice(8, 10)) >= 15 ? ym : addCalendarMonths(ym, -1);
}

/** Average length of a month in days, to count the months a billing period spans. */
const DAYS_PER_MONTH = 365.25 / 12;

/**
 * Months a bill pays for, from its printed period: a two-month gas period covers 2, a monthly bill
 * 1. Without a period, 1. The page spreads the bill over them, ending at its bill month.
 */
export function utilityBillMonthsCovered(b: Pick<UtilityBill, "period_from" | "period_to">): number {
  if (b.period_from == null || b.period_to == null) return 1;
  const days = (Date.parse(`${b.period_to}T00:00:00Z`) - Date.parse(`${b.period_from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`utility bill period ${b.period_from}..${b.period_to} is not a period`);
  }
  return Math.max(1, Math.round(days / DAYS_PER_MONTH));
}

/** The day a gastos line's charge happened. */
const lineDay = (l: Pick<FlowCcExpenseLineRow, "purchase_on" | "occurred_on">) => l.purchase_on ?? l.occurred_on;

/** The last day a bill's charge may be dated. */
export function chargeWindowEnd(bill: Pick<UtilityBill, "issued_on" | "due_on" | "service">): string {
  return bill.service === "hoa"
    ? chileCalendarAddDays(bill.issued_on, HOA_CHARGE_WINDOW_DAYS)
    : chileCalendarAddDays(bill.due_on, UTILITY_BILL_CHARGE_GRACE_DAYS);
}

/**
 * Whether a line pays the place's `kind`, by the bank's name for it; a transfer whose mail names
 * its counterparty must be paying someone else (not between the client's own accounts).
 */
function linePaysKind(l: FlowCcExpenseLineRow, comunidadPatterns: string | null, kind: RealEstateBillKind): boolean {
  if (l.transfer_counterparty && l.transfer_counterparty.direction !== "out") return false;
  return merchantMatchesExpectation(comunidadPatterns, kind, l.merchant ?? l.merchant_key);
}

/** A transfer whose mail names the place's counterparty for `kind`. */
function counterpartyIsKinds(l: FlowCcExpenseLineRow, comunidadPatterns: string | null, kind: RealEstateBillKind): boolean {
  const name = l.transfer_counterparty?.name;
  return name != null && merchantMatchesExpectation(comunidadPatterns, kind, name);
}

export type UtilityChargePick =
  | { kind: "one"; line: FlowCcExpenseLineRow }
  | { kind: "none" }
  | { kind: "ambiguous"; purchase_keys: string[] };

/** The charge that paid a bill among `lines` (see the module doc); `excluded` keys are taken. */
export function pickUtilityBillCharge(
  bill: Pick<UtilityBill, "amount" | "issued_on" | "due_on" | "service">,
  comunidadPatterns: string | null,
  lines: readonly FlowCcExpenseLineRow[],
  excluded: ReadonlySet<string>
): UtilityChargePick {
  const kind = UTILITY_SERVICE_KIND[bill.service];
  const last = chargeWindowEnd(bill);
  let candidates = lines.filter(
    (l) =>
      !excluded.has(l.purchase_key) &&
      Math.round(l.amount_clp) === bill.amount &&
      lineDay(l) >= bill.issued_on &&
      lineDay(l) <= last &&
      linePaysKind(l, comunidadPatterns, kind)
  );
  const named = candidates.filter((l) => counterpartyIsKinds(l, comunidadPatterns, kind));
  if (named.length > 0) candidates = named;
  const keys = [...new Set(candidates.map((l) => l.purchase_key))];
  if (keys.length === 0) return { kind: "none" };
  if (keys.length > 1) return { kind: "ambiguous", purchase_keys: keys.sort() };
  return { kind: "one", line: candidates[0]! };
}

type StoredBillRow = {
  provider: string;
  bill_number: string;
  service: UtilityService;
  service_account: string;
  issued_on: string;
  amount: number;
  due_on: string;
  period_from: string | null;
  period_to: string | null;
  kwh: number | null;
  m3: number | null;
  estimated_reading: number | null;
  message_id: string;
  expense_entry_id: number | null;
  settled_at: string | null;
};

/**
 * What a bill states, without its provenance or its period: two mails of one bill must state the
 * same. The period is compared apart — a feeder may know it on one send and not on another (ENEL's
 * comes from the previous bill, which a short fetch window leaves out).
 */
function contentHash(b: Omit<UtilityBill, "message_id">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([b.service, b.service_account, b.issued_on, b.amount, b.due_on, b.kwh, b.m3, b.estimated_reading])
    )
    .digest("hex");
}

function storedAsBill(r: StoredBillRow): UtilityBill {
  return {
    provider: r.provider,
    service: r.service,
    service_account: r.service_account,
    bill_number: r.bill_number,
    issued_on: r.issued_on,
    amount: r.amount,
    due_on: r.due_on,
    period_from: r.period_from,
    period_to: r.period_to,
    kwh: r.kwh,
    m3: r.m3,
    estimated_reading: r.estimated_reading == null ? null : r.estimated_reading === 1,
    message_id: r.message_id,
  };
}

type Place = { id: number; slug: string; comunidad_patterns: string | null };

/** provider|normalized account → the place its supply belongs to. */
function loadServicePlaces(): Map<string, Place> {
  const rows = db
    .prepare(
      `SELECT u.provider, u.service_account, a.id, a.slug, a.comunidad_merchant_patterns AS comunidad_patterns
       FROM utility_service_accounts u
       JOIN expense_accounts a ON a.id = u.expense_account_id
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate'`
    )
    .all() as ({ provider: string; service_account: string } & Place)[];
  const out = new Map<string, Place>();
  for (const r of rows) {
    const key = `${r.provider}|${normalizeServiceAccount(r.service_account)}`;
    const prev = out.get(key);
    if (prev && prev.id !== r.id) throw new Error(`utility account ${r.provider} ${r.service_account} names two places`);
    out.set(key, { id: r.id, slug: r.slug, comunidad_patterns: r.comunidad_patterns });
  }
  return out;
}

export type UtilityBillApplyOutcome =
  | { status: "applied" | "duplicate"; details: UtilityBillApplyDetails }
  | { status: "conflict"; message: string };

class ConflictError extends Error {}

const COLUMNS = [
  "provider", "bill_number", "service", "service_account", "issued_on", "amount", "due_on",
  "period_from", "period_to", "kwh", "m3", "estimated_reading", "message_id",
] as const;

/** Stores the new bills; a bill already stored with other content refuses the whole payload (`ConflictError`). */
function storeBills(bills: readonly UtilityBill[]): { new_bills: number } {
  const existing = db.prepare(`SELECT * FROM utility_bills WHERE provider = ? AND bill_number = ?`);
  const insert = db.prepare(
    `INSERT INTO utility_bills (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`
  );
  const setPeriod = db.prepare(`UPDATE utility_bills SET period_from = ?, period_to = ? WHERE provider = ? AND bill_number = ?`);
  return db.transaction(() => {
    const conflicts: string[] = [];
    let added = 0;
    for (const b of bills) {
      const old = existing.get(b.provider, b.bill_number) as StoredBillRow | undefined;
      if (old) {
        const oldPeriod = old.period_from == null ? null : `${old.period_from}|${old.period_to}`;
        const newPeriod = b.period_from == null ? null : `${b.period_from}|${b.period_to}`;
        if (contentHash(storedAsBill(old)) !== contentHash(b) || (oldPeriod && newPeriod && oldPeriod !== newPeriod)) {
          conflicts.push(`${b.provider} bill ${b.bill_number} was already stored with other content`);
        } else if (!oldPeriod && newPeriod) {
          setPeriod.run(b.period_from, b.period_to, b.provider, b.bill_number);
        }
        continue;
      }
      insert.run({ ...b, estimated_reading: b.estimated_reading == null ? null : b.estimated_reading ? 1 : 0 });
      added++;
    }
    if (conflicts.length > 0) throw new ConflictError(conflicts.join("; "));
    return { new_bills: added };
  }).immediate();
}

export function applyUtilityBills(
  payload: UtilityBillPayload,
  opts: { todayYmd?: string } = {}
): UtilityBillApplyOutcome {
  let stored: { new_bills: number };
  try {
    stored = storeBills(payload.bills);
  } catch (err) {
    if (err instanceof ConflictError) return { status: "conflict", message: err.message };
    throw err;
  }
  const todayYmd = opts.todayYmd ?? chileCalendarTodayYmd();
  const pending = db
    .prepare(`SELECT * FROM utility_bills WHERE settled_at IS NULL ORDER BY issued_on, provider, bill_number`)
    .all() as StoredBillRow[];
  const details: UtilityBillApplyDetails = {
    received: payload.bills.length,
    new_bills: stored.new_bills,
    bills: [],
    unbilled_hoa_payments: [],
  };
  const places = loadServicePlaces();
  const hoaPlaces = firstHoaStatementByPlace(places);
  if (pending.length === 0 && hoaPlaces.size === 0) return { status: stored.new_bills > 0 ? "applied" : "duplicate", details };

  let lines = loadGastosLinesForRealEstateMatching();
  const linkOfKey = () =>
    new Map(
      (db.prepare(`SELECT purchase_key, expense_entry_id FROM real_estate_expense_links`).all() as {
        purchase_key: string;
        expense_entry_id: number;
      }[]).map((r) => [r.purchase_key, r.expense_entry_id])
    );
  let links = linkOfKey();
  // Bill rows another utility bill created or filled: their charges are taken.
  const claimedEntries = new Set(
    (db.prepare(`SELECT expense_entry_id FROM utility_bills WHERE expense_entry_id IS NOT NULL`).all() as {
      expense_entry_id: number;
    }[]).map((r) => r.expense_entry_id)
  );
  const settle = db.prepare(
    `UPDATE utility_bills SET expense_entry_id = ?, settled_at = datetime('now') WHERE provider = ? AND bill_number = ?`
  );
  let wrote = false;
  // Charges a waiting statement could still take: not reported as unbilled.
  const followedKeys = new Set<string>();

  for (const row of pending) {
    const bill = storedAsBill(row);
    const kind = UTILITY_SERVICE_KIND[bill.service];
    const place = places.get(`${bill.provider}|${normalizeServiceAccount(bill.service_account)}`) ?? null;
    const report = (
      outcome: UtilityBillOutcome,
      extra: { expense_entry_id?: number | null; purchase_key?: string | null; message?: string | null } = {}
    ) =>
      details.bills.push({
        provider: bill.provider,
        bill_number: bill.bill_number,
        issued_on: bill.issued_on,
        amount: bill.amount,
        outcome,
        place: place?.slug ?? null,
        bill_month: utilityBillMonth(bill),
        expense_entry_id: extra.expense_entry_id ?? null,
        purchase_key: extra.purchase_key ?? null,
        message: extra.message ?? null,
      });

    if (bill.amount === 0) {
      settle.run(null, bill.provider, bill.bill_number);
      report("nothing_to_pay");
      continue;
    }
    if (!place) {
      report("unmapped", { message: `no place for ${bill.provider} account ${bill.service_account} (utility_service_accounts)` });
      continue;
    }
    const excluded = new Set(
      [...links].filter(([, entry]) => claimedEntries.has(entry)).map(([key]) => key)
    );
    let pick = pickUtilityBillCharge(bill, place.comunidad_patterns, lines, excluded);
    if (pick.kind === "ambiguous") {
      // Several charges fit (a bill paid twice, the second refunded): one already filed under a bill
      // is the bill's — the row it is filed under is then checked like any linked charge.
      const filed = pick.purchase_keys.filter((k) => links.has(k));
      const line = filed.length === 1 ? lines.find((l) => l.purchase_key === filed[0]) : undefined;
      if (line) pick = { kind: "one", line };
    }
    if (pick.kind === "ambiguous") {
      for (const k of pick.purchase_keys) followedKeys.add(k);
      report("ambiguous", { message: `charges ${pick.purchase_keys.join(", ")}` });
      continue;
    }
    if (pick.kind === "none") {
      const overdue = todayYmd > chileCalendarAddDays(chargeWindowEnd(bill), UTILITY_BILL_OVERDUE_DAYS);
      report(overdue ? "overdue" : "waiting");
      continue;
    }
    const key = pick.line.purchase_key;
    const consumption = { kwh: bill.kwh, m3: bill.m3 };
    const linkedEntry = links.get(key);
    if (linkedEntry == null) {
      const { expense_entry_id } = assignPurchaseToRealEstateExpense({
        purchaseKey: key,
        accountSlug: place.slug,
        kind,
        billMonth: utilityBillMonth(bill),
        kwh: consumption.kwh,
        m3: consumption.m3,
      });
      const monthsCovered = utilityBillMonthsCovered(bill);
      if (monthsCovered > 1) updateRealEstateExpenseMonthsCovered(expense_entry_id, monthsCovered);
      settle.run(expense_entry_id, bill.provider, bill.bill_number);
      claimedEntries.add(expense_entry_id);
      wrote = true;
      report("created", { expense_entry_id, purchase_key: key });
      // The created row links the charge: the next bill must see it.
      lines = loadGastosLinesForRealEstateMatching();
      links = linkOfKey();
      continue;
    }
    const entry = loadExpectationById(linkedEntry);
    const conflict = (message: string) => report("conflict", { expense_entry_id: linkedEntry, purchase_key: key, message });
    if (!entry) {
      conflict(`the charge is linked to bill row ${linkedEntry}, which is not a real-estate bill`);
      continue;
    }
    if (entry.expense_account_id !== place.id || entry.category !== kind) {
      conflict(`the charge is filed under ${entry.account_slug} / ${entry.category ?? "no kind"}, not ${place.slug} / ${kind}`);
      continue;
    }
    if (Math.round(entry.amount_clp) !== bill.amount) {
      conflict(`the bill row says ${Math.round(entry.amount_clp)} pesos, the bill ${bill.amount}`);
      continue;
    }
    const field = consumption.kwh != null ? "kwh" : consumption.m3 != null ? "m3" : null;
    if (field == null) {
      settle.run(linkedEntry, bill.provider, bill.bill_number);
      claimedEntries.add(linkedEntry);
      report("already_filed", { expense_entry_id: linkedEntry, purchase_key: key });
      continue;
    }
    const want = consumption[field]!;
    const have = entry[field];
    if (have != null && Math.abs(have - want) > 1e-9) {
      conflict(`the bill row has ${have} ${field}, the bill ${want}`);
      continue;
    }
    if (have == null) {
      updateRealEstateExpenseConsumption(linkedEntry, { kwh: entry.kwh, m3: entry.m3, [field]: want });
      wrote = true;
    }
    settle.run(linkedEntry, bill.provider, bill.bill_number);
    claimedEntries.add(linkedEntry);
    report(have == null ? "filled" : "already_filed", { expense_entry_id: linkedEntry, purchase_key: key });
  }
  details.unbilled_hoa_payments = unbilledHoaPayments(hoaPlaces, lines, new Set([...links.keys(), ...followedKeys]), todayYmd);
  return { status: stored.new_bills > 0 || wrote ? "applied" : "duplicate", details };
}

/** Each place that receives gastos comunes statements → the issue day of its first one. */
function firstHoaStatementByPlace(places: ReadonlyMap<string, Place>): Map<number, { place: Place; since: string }> {
  const rows = db
    .prepare(`SELECT provider, service_account, MIN(issued_on) AS since FROM utility_bills WHERE service = 'hoa' GROUP BY provider, service_account`)
    .all() as { provider: string; service_account: string; since: string }[];
  const out = new Map<number, { place: Place; since: string }>();
  for (const r of rows) {
    const place = places.get(`${r.provider}|${normalizeServiceAccount(r.service_account)}`);
    if (!place) continue;
    const prev = out.get(place.id);
    if (!prev || r.since < prev.since) out.set(place.id, { place, since: r.since });
  }
  return out;
}

/**
 * Gastos comunes payments of a place that receives statements, which no bill row holds (`taken`:
 * linked to a bill, or still a candidate of a waiting statement), dated from its first statement
 * through `UNBILLED_HOA_PAYMENT_GRACE_DAYS` ago: the statement for their month never arrived.
 */
export function unbilledHoaPayments(
  hoaPlaces: ReadonlyMap<number, { place: Place; since: string }>,
  lines: readonly FlowCcExpenseLineRow[],
  taken: ReadonlySet<string>,
  todayYmd: string
): UtilityBillApplyDetails["unbilled_hoa_payments"] {
  const until = chileCalendarAddDays(todayYmd, -UNBILLED_HOA_PAYMENT_GRACE_DAYS);
  const out: UtilityBillApplyDetails["unbilled_hoa_payments"] = [];
  for (const { place, since } of hoaPlaces.values()) {
    for (const l of lines) {
      if (taken.has(l.purchase_key) || lineDay(l) < since || lineDay(l) > until) continue;
      if (!linePaysKind(l, place.comunidad_patterns, "gastos_comunes")) continue;
      out.push({ place: place.slug, purchase_key: l.purchase_key, day: lineDay(l), amount: Math.round(l.amount_clp), merchant: l.merchant });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.purchase_key.localeCompare(b.purchase_key));
}
