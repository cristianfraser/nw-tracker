import { densifyMonthlyPoints, densifyYearlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
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
  account_slug: string;
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
  account_slug: string;
  label: string;
  slots: RealEstateBillSlot[];
  total_clp: number;
};

/** One row of `expense_accounts` under the real_estate group — the tracked places. */
export type RealEstatePlaceDto = {
  slug: string;
  label: string;
  sort_order: number;
  active_from: string | null;
  active_to: string | null;
  property_account_id: number | null;
};

type RealEstatePlaceRow = RealEstatePlaceDto & { comunidad_merchant_patterns: string | null };

export type RealEstateExpenseChartPoint = {
  as_of_date: string;
  total: number;
} & Record<string, number | string>;

export type RealEstateExpensesPayload = {
  places: RealEstatePlaceDto[];
  slots: RealEstateBillSlot[];
  by_account: Record<string, RealEstateExpenseAccountBlock>;
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

export function listRealEstatePlaces(): RealEstatePlaceRow[] {
  return db
    .prepare(
      `SELECT a.slug, a.label, a.sort_order, a.active_from, a.active_to,
              a.property_account_id, a.comunidad_merchant_patterns
       FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate'
       ORDER BY a.sort_order, a.id`
    )
    .all() as RealEstatePlaceRow[];
}

function placeToDto(place: RealEstatePlaceRow): RealEstatePlaceDto {
  const { comunidad_merchant_patterns: _patterns, ...dto } = place;
  return dto;
}

const PLACE_SLUG_RE = /^[a-z0-9_]+$/;

/** Create a tracked place (a row under the real_estate expense group). */
export function createRealEstatePlace(opts: {
  slug: string;
  label: string;
  activeFrom?: string | null;
  activeTo?: string | null;
  propertyAccountId?: number | null;
}): RealEstatePlaceDto {
  const slug = opts.slug.trim();
  const label = opts.label.trim();
  if (!PLACE_SLUG_RE.test(slug)) throw new Error("slug must be lowercase [a-z0-9_]");
  if (!label) throw new Error("label required");
  for (const m of [opts.activeFrom, opts.activeTo]) {
    if (m != null && m !== "" && !/^\d{4}-\d{2}$/.test(m)) {
      throw new Error("active_from/active_to must be YYYY-MM");
    }
  }
  if (opts.propertyAccountId != null) {
    const acc = db.prepare(`SELECT 1 FROM accounts WHERE id = ?`).get(opts.propertyAccountId);
    if (!acc) throw new Error(`unknown property account id ${opts.propertyAccountId}`);
  }

  const group = db
    .prepare(`SELECT id FROM expense_groups WHERE slug = 'real_estate'`)
    .get() as { id: number } | undefined;
  const groupId =
    group?.id ??
    Number(
      db
        .prepare(`INSERT INTO expense_groups (slug, label, sort_order) VALUES ('real_estate', 'Inmuebles', 0)`)
        .run().lastInsertRowid
    );

  const dup = db
    .prepare(`SELECT 1 FROM expense_accounts WHERE group_id = ? AND slug = ?`)
    .get(groupId, slug);
  if (dup) throw new Error(`place '${slug}' already exists`);

  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM expense_accounts WHERE group_id = ?`)
    .get(groupId) as { m: number };
  const sortOrder = maxSort.m + 10;

  db.prepare(
    `INSERT INTO expense_accounts (group_id, slug, label, sort_order, active_from, active_to, property_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    groupId,
    slug,
    label,
    sortOrder,
    opts.activeFrom || null,
    opts.activeTo || null,
    opts.propertyAccountId ?? null
  );

  return {
    slug,
    label,
    sort_order: sortOrder,
    active_from: opts.activeFrom || null,
    active_to: opts.activeTo || null,
    property_account_id: opts.propertyAccountId ?? null,
  };
}

function periodEndFromBillMonth(billMonth: string, granularity: "month" | "year"): string {
  if (granularity === "year") return `${billMonth.slice(0, 4)}-12-31`;
  return monthEndUtcYmd(billMonth);
}

function aggregateChartPoints(
  slots: readonly RealEstateBillSlot[],
  places: readonly RealEstatePlaceRow[],
  granularity: "month" | "year"
): RealEstateExpenseChartPoint[] {
  const emptyPoint = (as_of_date: string): RealEstateExpenseChartPoint => {
    const pt: RealEstateExpenseChartPoint = { as_of_date, total: 0 };
    for (const p of places) pt[p.slug] = 0;
    return pt;
  };

  const byPeriod = new Map<string, RealEstateExpenseChartPoint>();
  for (const slot of slots) {
    if (slot.display_amount_clp <= 0) continue;
    const pe = periodEndFromBillMonth(slot.bill_month, granularity);
    let pt = byPeriod.get(pe);
    if (!pt) {
      pt = emptyPoint(pe);
      byPeriod.set(pe, pt);
    }
    pt[slot.account_slug] = Number(pt[slot.account_slug] ?? 0) + slot.display_amount_clp;
    pt.total += slot.display_amount_clp;
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
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
 * Monthly dividendo as read-only slots for every place linked to a property master
 * (`expense_accounts.property_account_id`), sourced from the depto ledger. Regular
 * cuotas only — pie and prepagos are capital events, not monthly expenses. The cash
 * cost is the component sum (amortización + interés + seguros); the movement's
 * `amount_clp` is an equity mark, not the payment.
 */
function mortgageLedgerSlots(places: readonly RealEstatePlaceRow[]): RealEstateBillSlot[] {
  const linked = places.filter((p) => p.property_account_id != null);
  if (linked.length === 0) return [];

  const slots: RealEstateBillSlot[] = [];
  const stmt = db.prepare(
    `SELECT m.occurred_on,
            COALESCE(p.amortizacion_clp, 0) + COALESCE(p.interes_clp, 0)
              + COALESCE(p.incendio_clp, 0) + COALESCE(p.desgravamen_clp, 0) AS pago_clp
     FROM movements m
     JOIN depto_payments p ON p.movement_id = m.id
     WHERE m.account_id = ?
       AND p.kind = 'dividendos'
       AND LOWER(TRIM(p.cuota)) != 'pie'
       AND p.cuota NOT LIKE 'prepago%'
     ORDER BY m.occurred_on DESC`
  );
  for (const place of linked) {
    const rows = stmt.all(place.property_account_id) as {
      occurred_on: string;
      pago_clp: number;
    }[];
    for (const r of rows) {
      if (r.pago_clp <= 0) continue;
      slots.push({
        expense_entry_id: null,
        account_slug: place.slug,
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
      });
    }
  }
  return slots;
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
  const places = listRealEstatePlaces();
  const linksByEntry = ensureAutoLinks();
  const expectations = listRealEstateExpectations();
  const gastosLines = loadGastosLinesForRealEstateMatching();

  const slots = expectations
    .map((exp) => expectationToSlot(exp, linksByEntry.get(exp.id), gastosLines))
    .concat(mortgageLedgerSlots(places))
    .sort((a, b) => b.spent_on.localeCompare(a.spent_on));

  const by_account: Record<string, RealEstateExpenseAccountBlock> = {};
  for (const place of places) {
    const accountSlots = slots.filter((s) => s.account_slug === place.slug);
    by_account[place.slug] = {
      account_slug: place.slug,
      label: place.label,
      slots: accountSlots,
      total_clp: accountSlots.reduce((s, sl) => s + sl.display_amount_clp, 0),
    };
  }

  const chart_monthly = aggregateChartPoints(slots, places, "month");
  const chart_yearly = aggregateChartPoints(slots, places, "year");
  const total_clp = slots.reduce((s, sl) => s + sl.display_amount_clp, 0);

  return {
    places: places.map(placeToDto),
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
  category_slug: string;
  merchant_matches: boolean;
};

const UNLINKED_PURCHASES_DEFAULT_LIMIT = 200;

/**
 * Eligible gastos lines with no real-estate link yet — the candidate pool for
 * purchase-first assignment. Filters: `q` (merchant + origin label substring),
 * `month` (purchase month), `category` (gastos category slug, e.g. 'bills'),
 * `placeSlug` (scope to the place's occupancy period, +2 months tail for late card
 * charges), `kind` (flags + floats merchant-pattern matches). Newest first.
 */
export function listRealEstateUnlinkedPurchases(opts?: {
  q?: string;
  month?: string;
  category?: string;
  placeSlug?: string;
  kind?: string;
  limit?: number;
}): RealEstateUnlinkedPurchaseDto[] {
  const gastosLines = loadGastosLinesForRealEstateMatching();
  const linkedKeys = new Set([...loadExistingLinks().values()].map((l) => l.purchase_key));
  const q = (opts?.q ?? "").trim().toLowerCase();
  const month = (opts?.month ?? "").trim();
  const category = (opts?.category ?? "").trim();
  const kind = (opts?.kind ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? UNLINKED_PURCHASES_DEFAULT_LIMIT, 1000));

  const place = opts?.placeSlug
    ? listRealEstatePlaces().find((p) => p.slug === opts.placeSlug)
    : undefined;
  const periodFrom = place?.active_from ?? null;
  const periodTo = place?.active_to ? addCalendarMonths(place.active_to, 2) : null;

  const matches = (ln: FlowCcExpenseLineRow): boolean =>
    kind ? merchantMatchesExpectation(place?.comunidad_merchant_patterns ?? null, kind, ln.merchant_key) : false;

  return gastosLines
    .filter((ln) => !linkedKeys.has(ln.purchase_key))
    .filter((ln) => (category ? ln.category_slug === category : true))
    .filter((ln) => {
      const m = purchaseMonthForLine(ln);
      if (month && m !== month) return false;
      if (periodFrom && m < periodFrom) return false;
      if (periodTo && m > periodTo) return false;
      return true;
    })
    .filter((ln) =>
      q ? `${ln.merchant ?? ""} ${ln.origin_label ?? ""}`.toLowerCase().includes(q) : true
    )
    .map((ln) => ({
      purchase_key: ln.purchase_key,
      merchant: ln.merchant,
      purchase_on: ln.purchase_on,
      purchase_month: purchaseMonthForLine(ln),
      amount_clp: ln.amount_clp,
      origin_label: ln.origin_label ?? "",
      source: ln.source,
      category_slug: ln.category_slug,
      merchant_matches: matches(ln),
    }))
    .sort((a, b) => {
      if (a.merchant_matches !== b.merchant_matches) return a.merchant_matches ? -1 : 1;
      return (b.purchase_on ?? "").localeCompare(a.purchase_on ?? "");
    })
    .slice(0, limit);
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
        exp.comunidad_patterns,
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
