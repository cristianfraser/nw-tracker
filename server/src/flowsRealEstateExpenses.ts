import { densifyMonthlyPoints, densifyYearlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import type {
  FlowCcExpenseLineRow,
  FlowCcExpenseLineSource,
} from "./flowsCreditCardExpenses.js";
import { merchantMatchesExpectation } from "./realEstateExpenseMerchants.js";
import {
  billMonthFromSpentOn,
  displayAmountClp,
  findAmountMatchCandidates,
  gastosLineByPurchaseKey,
  loadExistingLinks,
  loadExpectationById,
  loadGastosLinesForRealEstateMatching,
  listRealEstateExpectations,
  loadAllRejections,
  dropInvalidRealEstateExpenseLinks,
  persistAutoLinks,
  purchaseMonthForLine,
  purchaseMonthOffsetFromBill,
  runAutoLinkPass,
  type ExpenseExpectationRow,
  type RealEstateLinkRow,
} from "./realEstateExpenseMatching.js";
import type { RealEstateApartmentSlug } from "./realEstateExpenseMerchants.js";

export type RealEstateExpenseLinkDto = {
  purchase_key: string;
  link_source: "auto" | "manual";
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
};

export type RealEstateBillSlot = {
  /** Null for read-only rows derived from the depto ledger (mortgage). */
  expense_entry_id: number | null;
  account_slug: RealEstateApartmentSlug;
  bill_month: string;
  spent_on: string;
  kind: string;
  expected_amount_clp: number;
  link: RealEstateExpenseLinkDto | null;
  display_amount_clp: number;
  note: string | null;
  kwh: number | null;
  m3: number | null;
  can_link: boolean;
};

export type RealEstateExpenseAccountBlock = {
  account_slug: RealEstateApartmentSlug;
  label: string;
  slots: RealEstateBillSlot[];
  total_clp: number;
};

export type RealEstateExpenseChartPoint = {
  as_of_date: string;
  real_estate: number;
  lastarria: number;
  suecia: number;
  el_vergel: number;
  total: number;
};

export type RealEstateExpensesPayload = {
  slots: RealEstateBillSlot[];
  by_account: Record<RealEstateApartmentSlug, RealEstateExpenseAccountBlock>;
  chart_monthly: RealEstateExpenseChartPoint[];
  chart_yearly: RealEstateExpenseChartPoint[];
  total_clp: number;
};

export type RealEstateLinkCandidateDto = {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
  merchant_matches: boolean;
  /** Months from bill month (0 = same month, 1–2 = later card payment). */
  purchase_month_offset: number;
};

const ACCOUNT_LABELS: Record<RealEstateApartmentSlug, string> = {
  el_vergel: "El Vergel",
  lastarria: "Lastarria",
  suecia: "Suecia",
};

const ACCOUNT_ORDER: RealEstateApartmentSlug[] = ["el_vergel", "lastarria", "suecia"];

function periodEndFromBillMonth(billMonth: string, granularity: "month" | "year"): string {
  if (granularity === "year") return `${billMonth.slice(0, 4)}-12-31`;
  return monthEndUtcYmd(billMonth);
}

function aggregateChartPoints(
  slots: readonly RealEstateBillSlot[],
  granularity: "month" | "year"
): RealEstateExpenseChartPoint[] {
  const byPeriod = new Map<string, RealEstateExpenseChartPoint>();
  for (const slot of slots) {
    if (slot.display_amount_clp <= 0) continue;
    const pe = periodEndFromBillMonth(slot.bill_month, granularity);
    let pt = byPeriod.get(pe);
    if (!pt) {
      pt = {
        as_of_date: pe,
        real_estate: 0,
        lastarria: 0,
        suecia: 0,
        el_vergel: 0,
        total: 0,
      };
      byPeriod.set(pe, pt);
    }
    if (slot.account_slug === "lastarria") pt.lastarria += slot.display_amount_clp;
    else if (slot.account_slug === "suecia") pt.suecia += slot.display_amount_clp;
    else if (slot.account_slug === "el_vergel") pt.el_vergel += slot.display_amount_clp;
    pt.real_estate += slot.display_amount_clp;
    pt.total += slot.display_amount_clp;
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const emptyPoint = (as_of_date: string): RealEstateExpenseChartPoint => ({
    as_of_date, real_estate: 0, lastarria: 0, suecia: 0, el_vergel: 0, total: 0,
  });
  if (granularity === "year") return densifyYearlyPoints(sorted, emptyPoint);
  return densifyMonthlyPoints(sorted, emptyPoint);
}

function linkToDto(
  link: RealEstateLinkRow,
  line: FlowCcExpenseLineRow
): RealEstateExpenseLinkDto {
  return {
    purchase_key: link.purchase_key,
    link_source: link.link_source,
    merchant: line.merchant,
    purchase_on: line.purchase_on,
    amount_clp: line.amount_clp,
    origin_label: line.origin_label ?? "",
    source: line.source,
  };
}

function expectationToSlot(
  exp: ExpenseExpectationRow,
  link: RealEstateLinkRow | undefined,
  gastosLines: readonly FlowCcExpenseLineRow[]
): RealEstateBillSlot {
  const kind = exp.category ?? "";
  const linkedLine = link ? gastosLineByPurchaseKey(link.purchase_key, gastosLines) : undefined;
  const bill_month = monthKeyFromYmd(exp.spent_on);
  return {
    expense_entry_id: exp.id,
    account_slug: exp.account_slug,
    bill_month,
    spent_on: exp.spent_on,
    kind,
    expected_amount_clp: exp.amount_clp,
    link: link && linkedLine ? linkToDto(link, linkedLine) : null,
    display_amount_clp: displayAmountClp(exp.amount_clp, linkedLine),
    note: exp.note,
    kwh: exp.kwh,
    m3: exp.m3,
    can_link: exp.amount_clp > 0,
  };
}

/**
 * Suecia's monthly dividendo as read-only slots sourced from the depto ledger (regular
 * cuotas only — pie and prepagos are capital events, not monthly expenses). The cash
 * cost is the component sum (amortización + interés + seguros); the movement's
 * `amount_clp` is an equity mark, not the payment.
 */
function mortgageLedgerSlots(): RealEstateBillSlot[] {
  const rows = db
    .prepare(
      `SELECT m.occurred_on,
              COALESCE(p.amortizacion_clp, 0) + COALESCE(p.interes_clp, 0)
                + COALESCE(p.incendio_clp, 0) + COALESCE(p.desgravamen_clp, 0) AS pago_clp
       FROM movements m
       JOIN depto_payments p ON p.movement_id = m.id
       WHERE p.kind = 'dividendos'
         AND LOWER(TRIM(p.cuota)) != 'pie'
         AND p.cuota NOT LIKE 'prepago%'
       ORDER BY m.occurred_on DESC`
    )
    .all() as { occurred_on: string; pago_clp: number }[];

  return rows
    .filter((r) => r.pago_clp > 0)
    .map((r) => ({
      expense_entry_id: null,
      account_slug: "suecia" as const,
      bill_month: monthKeyFromYmd(r.occurred_on),
      spent_on: r.occurred_on,
      kind: "mortgage",
      expected_amount_clp: Math.round(r.pago_clp),
      link: null,
      display_amount_clp: Math.round(r.pago_clp),
      note: null,
      kwh: null,
      m3: null,
      can_link: false,
    }));
}

function ensureAutoLinks(): Map<number, RealEstateLinkRow> {
  const expectations = listRealEstateExpectations();
  const gastosLines = loadGastosLinesForRealEstateMatching();
  dropInvalidRealEstateExpenseLinks(expectations, gastosLines, loadExistingLinks());
  let existing = loadExistingLinks();
  const newLinks = runAutoLinkPass(expectations, gastosLines, existing);
  if (newLinks.length > 0) {
    persistAutoLinks(newLinks);
    existing = loadExistingLinks();
  }
  return existing;
}

export function buildRealEstateExpensesPayload(): RealEstateExpensesPayload {
  const linksByEntry = ensureAutoLinks();
  const expectations = listRealEstateExpectations();
  const gastosLines = loadGastosLinesForRealEstateMatching();

  const slots = expectations
    .map((exp) => expectationToSlot(exp, linksByEntry.get(exp.id), gastosLines))
    .concat(mortgageLedgerSlots())
    .sort((a, b) => b.spent_on.localeCompare(a.spent_on));

  const by_account = {} as Record<RealEstateApartmentSlug, RealEstateExpenseAccountBlock>;
  for (const slug of ACCOUNT_ORDER) {
    const accountSlots = slots.filter((s) => s.account_slug === slug);
    by_account[slug] = {
      account_slug: slug,
      label: ACCOUNT_LABELS[slug],
      slots: accountSlots,
      total_clp: accountSlots.reduce((s, sl) => s + sl.display_amount_clp, 0),
    };
  }

  const chart_monthly = aggregateChartPoints(slots, "month");
  const chart_yearly = aggregateChartPoints(slots, "year");
  const total_clp = slots.reduce((s, sl) => s + sl.display_amount_clp, 0);

  return {
    slots,
    by_account,
    chart_monthly,
    chart_yearly,
    total_clp,
  };
}

export type RealEstateUnlinkedPurchaseDto = {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  purchase_month: string;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
};

const UNLINKED_PURCHASES_DEFAULT_LIMIT = 200;

/**
 * Eligible gastos lines with no real-estate link yet, newest first — the candidate pool
 * for purchase-first assignment. `q` filters on merchant + origin label (case-insensitive
 * substring); `month` restricts to a purchase month (YYYY-MM).
 */
export function listRealEstateUnlinkedPurchases(opts?: {
  q?: string;
  month?: string;
  limit?: number;
}): RealEstateUnlinkedPurchaseDto[] {
  const gastosLines = loadGastosLinesForRealEstateMatching();
  const linkedKeys = new Set([...loadExistingLinks().values()].map((l) => l.purchase_key));
  const q = (opts?.q ?? "").trim().toLowerCase();
  const month = (opts?.month ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? UNLINKED_PURCHASES_DEFAULT_LIMIT, 1000));

  return gastosLines
    .filter((ln) => !linkedKeys.has(ln.purchase_key))
    .filter((ln) => (month ? purchaseMonthForLine(ln) === month : true))
    .filter((ln) =>
      q
        ? `${ln.merchant ?? ""} ${ln.origin_label ?? ""}`.toLowerCase().includes(q)
        : true
    )
    .sort((a, b) => (b.purchase_on ?? "").localeCompare(a.purchase_on ?? ""))
    .slice(0, limit)
    .map((ln) => ({
      purchase_key: ln.purchase_key,
      merchant: ln.merchant,
      purchase_on: ln.purchase_on,
      purchase_month: purchaseMonthForLine(ln),
      amount_clp: ln.amount_clp,
      origin_label: ln.origin_label ?? "",
      source: ln.source,
    }));
}

export function listRealEstateLinkCandidates(expenseEntryId: number): RealEstateLinkCandidateDto[] {
  const exp = loadExpectationById(expenseEntryId);
  if (!exp || exp.amount_clp <= 0) return [];

  const gastosLines = loadGastosLinesForRealEstateMatching();
  const linkedKeys = new Set([...loadExistingLinks().values()].map((l) => l.purchase_key));
  const rejections = loadAllRejections().get(expenseEntryId) ?? new Set<string>();
  const candidates = findAmountMatchCandidates(exp, gastosLines, linkedKeys, rejections);
  const billMonth = billMonthFromSpentOn(exp.spent_on);

  return candidates
    .map((ln) => ({
      purchase_key: ln.purchase_key,
      merchant: ln.merchant,
      purchase_on: ln.purchase_on,
      amount_clp: ln.amount_clp,
      origin_label: ln.origin_label ?? "",
      source: ln.source,
      merchant_matches: merchantMatchesExpectation(
        exp.account_slug,
        exp.category ?? "",
        ln.merchant_key
      ),
      purchase_month_offset:
        purchaseMonthOffsetFromBill(billMonth, purchaseMonthForLine(ln)) ?? 99,
    }))
    .sort((a, b) => {
      if (a.merchant_matches !== b.merchant_matches) return a.merchant_matches ? -1 : 1;
      if (a.purchase_month_offset !== b.purchase_month_offset) {
        return a.purchase_month_offset - b.purchase_month_offset;
      }
      const da = a.purchase_on ?? "";
      const db = b.purchase_on ?? "";
      return db.localeCompare(da);
    });
}
