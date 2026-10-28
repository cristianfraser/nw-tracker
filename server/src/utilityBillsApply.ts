/**
 * Utility bills (`utility.bill`): an electricity, gas, water or internet bill read from the
 * provider's mail becomes the real-estate page's bill row for its place — once, and only once the
 * card or checking charge that paid it is in. Nothing that has not happened appears on the page.
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
 *    is the kind's (`merchantMatchesExpectation`), dated from the issue day through due + 10 days.
 *    Several → ambiguous; none → waiting, and overdue once past due + 15 days.
 *  - a charge no bill row holds yet → a bill row created from it (`assignPurchaseToRealEstateExpense`)
 *    in the bill's month (`utilityBillMonth`) with the consumption; a charge already filed under a
 *    bill by hand → that bill's consumption filled when empty. A bill row of another place, kind or
 *    amount, or a different consumption already stored, is a conflict: never overwritten.
 * A bill that created or filled its row is settled and never followed again (a row deleted by hand
 * afterwards is not written back).
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
} from "./realEstateExpenseMatching.js";
import { merchantMatchesExpectation, type RealEstateBillKind } from "./realEstateExpenseMerchants.js";

/** How long after its due day a bill's charge may still be dated. */
export const UTILITY_BILL_CHARGE_GRACE_DAYS = 10;
/** Past due + this many days with no charge, a bill is reported overdue. */
export const UTILITY_BILL_OVERDUE_DAYS = 15;

/** The real-estate bill kind each service is filed under. */
export const UTILITY_SERVICE_KIND: Record<UtilityService, RealEstateBillKind> = {
  electricity: "electricidad",
  gas: "gas",
  water: "water",
  internet: "internet",
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

/** The day a gastos line's charge happened. */
const lineDay = (l: Pick<FlowCcExpenseLineRow, "purchase_on" | "occurred_on">) => l.purchase_on ?? l.occurred_on;

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
  const last = chileCalendarAddDays(bill.due_on, UTILITY_BILL_CHARGE_GRACE_DAYS);
  const candidates = lines.filter(
    (l) =>
      !excluded.has(l.purchase_key) &&
      Math.round(l.amount_clp) === bill.amount &&
      lineDay(l) >= bill.issued_on &&
      lineDay(l) <= last &&
      merchantMatchesExpectation(comunidadPatterns, kind, l.merchant ?? l.merchant_key)
  );
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
  const details: UtilityBillApplyDetails = { received: payload.bills.length, new_bills: stored.new_bills, bills: [] };
  if (pending.length === 0) return { status: stored.new_bills > 0 ? "applied" : "duplicate", details };

  const places = loadServicePlaces();
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
    const pick = pickUtilityBillCharge(bill, place.comunidad_patterns, lines, excluded);
    if (pick.kind === "ambiguous") {
      report("ambiguous", { message: `charges ${pick.purchase_keys.join(", ")}` });
      continue;
    }
    if (pick.kind === "none") {
      const overdue = todayYmd > chileCalendarAddDays(bill.due_on, UTILITY_BILL_OVERDUE_DAYS);
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
  return { status: stored.new_bills > 0 || wrote ? "applied" : "duplicate", details };
}
