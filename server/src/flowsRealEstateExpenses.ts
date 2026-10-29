import { densifyMonthlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { db } from "./db.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import type {
  FlowCcExpenseLineRow,
  FlowCcExpenseLineSource,
} from "./flowsExpenses.js";
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
  findInvalidRealEstateExpenseLinks,
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

/**
 * A stored link that no longer holds: its purchase is not among the eligible lines any more
 * (re-imported under another key, recategorized, deleted), or its month left the bill's
 * +0..+2 window. Shown on the page, never deleted on read.
 */
export type RealEstateBrokenLinkDto = {
  purchase_key: string;
  problem: "missing_purchase" | "outside_window";
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
  broken_link: RealEstateBrokenLinkDto | null;
  display_amount_clp: number;
  note: string | null;
  kwh: number | null;
  m3: number | null;
  /** Months the payment covers, ending at `bill_month` (1 = that month alone). */
  months_covered: number;
  /** First month the payment covers (`bill_month` when it covers one). */
  covers_from: string;
  /**
   * A mortgage cuota as paid, split: the scheduled amortización, the extra amortization paid above
   * the minimum, and carrying = interés + fire and mortgage-life insurance. Null on every other bill.
   */
  mortgage_parts: { amortization_clp: number; extra_amortization_clp: number; carrying_clp: number } | null;
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

export type RealEstatePlaceRow = RealEstatePlaceDto & { comunidad_merchant_patterns: string | null };

export type RealEstateExpenseChartPoint = {
  as_of_date: string;
  total: number;
} & Record<string, number | string>;

/**
 * Bill kinds in stacking order (bottom first). Every kind a slot can carry with an amount is here;
 * a kind outside it throws when the chart is built (`kwh` readings carry no amount).
 */
export const REAL_ESTATE_CHART_KINDS = [
  "mortgage_carrying",
  "mortgage_amortization",
  "rent",
  "gastos_comunes",
  "electricidad",
  "water",
  "internet",
  "gas",
  "contribuciones",
  "mortgage_extra_amortization",
] as const;

/** One stacked series: a place's spend on one kind of bill. */
export type RealEstateChartSeriesDto = {
  data_key: string;
  place_slug: string;
  kind: (typeof REAL_ESTATE_CHART_KINDS)[number];
  /** Places alternate between the two schemes in date order, so one place hands over to the next. */
  scheme: "base" | "alternate";
};

/**
 * The chart for one scope (every place, or one): its series and monthly points, from the scope's
 * first to its last month with a bill — a place that ended stops there, so the page's Rango counts
 * back from the scope's last point, not from today.
 */
export type RealEstateChartScopeDto = {
  series: RealEstateChartSeriesDto[];
  /** The kinds the scope draws, in stacking order (the legend's order). */
  kinds: RealEstateChartSeriesDto["kind"][];
  points: RealEstateExpenseChartPoint[];
};

export type RealEstateExpensesPayload = {
  places: RealEstatePlaceDto[];
  slots: RealEstateBillSlot[];
  by_account: Record<string, RealEstateExpenseAccountBlock>;
  /**
   * Keyed `all` and by place slug. Monthly only: the page's yearly chart rolls these up client-side
   * AFTER cutting the months at its own Rango (a partial first year).
   */
  chart_scopes: Record<string, RealEstateChartScopeDto>;
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

/** Places in date order (first occupied first), which is the order their schemes alternate in. */
function placesInDateOrder(places: readonly RealEstatePlaceRow[]): RealEstatePlaceRow[] {
  return [...places].sort(
    (a, b) => (a.active_from ?? "").localeCompare(b.active_from ?? "") || a.sort_order - b.sort_order
  );
}

/** The chart series a bill feeds: a mortgage cuota feeds its principal and carrying parts. */
export function chartPartsOf(slot: RealEstateBillSlot): { kind: RealEstateChartSeriesDto["kind"]; amount: number }[] {
  if (slot.kind === "mortgage") {
    if (!slot.mortgage_parts) throw new Error(`real-estate chart: mortgage cuota ${slot.spent_on} has no parts`);
    return [
      { kind: "mortgage_amortization", amount: slot.mortgage_parts.amortization_clp },
      { kind: "mortgage_extra_amortization", amount: slot.mortgage_parts.extra_amortization_clp },
      { kind: "mortgage_carrying", amount: slot.mortgage_parts.carrying_clp },
    ];
  }
  const kind = REAL_ESTATE_CHART_KINDS.find((k) => k === slot.kind);
  if (!kind) {
    throw new Error(`real-estate chart: bill kind '${slot.kind}' (${slot.account_slug} ${slot.bill_month}) has no chart series`);
  }
  return [{ kind, amount: slot.display_amount_clp }];
}

/**
 * A payment that covers several months, in equal whole-peso shares over the months ending at its
 * bill month; the last month takes the rounding remainder, so the shares add up to the payment.
 */
export function spreadOverCoveredMonths(
  slot: Pick<RealEstateBillSlot, "bill_month" | "months_covered" | "display_amount_clp">
): { month: string; amount: number }[] {
  const n = slot.months_covered;
  if (!Number.isInteger(n) || n < 1) throw new Error(`months_covered ${n} is not a positive integer`);
  const share = Math.floor(slot.display_amount_clp / n);
  const out: { month: string; amount: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push({ month: addCalendarMonths(slot.bill_month, -i), amount: i === 0 ? slot.display_amount_clp - share * (n - 1) : share });
  }
  return out;
}

/**
 * Kinds drawn below zero: the extra amortization paid above the minimum cuota is saving into the
 * property, not the month's cost (the scheduled amortization stays above, part of the cuota).
 */
const REAL_ESTATE_BELOW_ZERO_KINDS: ReadonlySet<RealEstateChartSeriesDto["kind"]> = new Set([
  "mortgage_extra_amortization",
]);

function chartScope(
  slots: readonly RealEstateBillSlot[],
  schemeByPlace: ReadonlyMap<string, RealEstateChartSeriesDto["scheme"]>,
  placeOrder: readonly string[]
): RealEstateChartScopeDto {
  const used = new Map<string, RealEstateChartSeriesDto>();
  const byPeriod = new Map<string, RealEstateExpenseChartPoint>();
  for (const slot of slots) {
    if (slot.display_amount_clp <= 0) continue;
    for (const part of chartPartsOf(slot)) {
      if (part.amount <= 0) continue;
      const dataKey = `${slot.account_slug}__${part.kind}`;
      if (!used.has(dataKey)) {
        const scheme = schemeByPlace.get(slot.account_slug);
        if (!scheme) throw new Error(`real-estate chart: unknown place '${slot.account_slug}'`);
        used.set(dataKey, { data_key: dataKey, place_slug: slot.account_slug, kind: part.kind, scheme });
      }
      const spread = spreadOverCoveredMonths({
        bill_month: slot.bill_month,
        months_covered: slot.months_covered,
        display_amount_clp: part.amount,
      });
      const sign = REAL_ESTATE_BELOW_ZERO_KINDS.has(part.kind) ? -1 : 1;
      for (const { month, amount } of spread) {
        const pe = monthEndUtcYmd(month);
        let pt = byPeriod.get(pe);
        if (!pt) {
          pt = { as_of_date: pe, total: 0 };
          byPeriod.set(pe, pt);
        }
        pt[dataKey] = Number(pt[dataKey] ?? 0) + sign * amount;
        // The total counts what was paid, the below-zero kinds included.
        pt.total += amount;
      }
    }
  }
  // Stack by place (date order), then by kind; every point carries every series (0 when none).
  const series = [...used.values()].sort(
    (a, b) =>
      placeOrder.indexOf(a.place_slug) - placeOrder.indexOf(b.place_slug) ||
      REAL_ESTATE_CHART_KINDS.indexOf(a.kind) - REAL_ESTATE_CHART_KINDS.indexOf(b.kind)
  );
  const emptyPoint = (as_of_date: string): RealEstateExpenseChartPoint => {
    const pt: RealEstateExpenseChartPoint = { as_of_date, total: 0 };
    for (const s of series) pt[s.data_key] = 0;
    return pt;
  };
  const sorted = [...byPeriod.values()]
    .map((p) => ({ ...emptyPoint(p.as_of_date), ...p }))
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const kinds = REAL_ESTATE_CHART_KINDS.filter((k) => series.some((s) => s.kind === k));
  return { series, kinds, points: densifyMonthlyPoints(sorted, emptyPoint) };
}

export function buildChartScopes(
  slots: readonly RealEstateBillSlot[],
  places: readonly RealEstatePlaceRow[]
): Record<string, RealEstateChartScopeDto> {
  const ordered = placesInDateOrder(places);
  const placeOrder = ordered.map((p) => p.slug);
  const schemeByPlace = new Map(
    ordered.map((p, i) => [p.slug, i % 2 === 0 ? ("base" as const) : ("alternate" as const)])
  );
  const scopes: Record<string, RealEstateChartScopeDto> = {
    all: chartScope(slots, schemeByPlace, placeOrder),
  };
  for (const place of places) {
    if (place.slug === "all") throw new Error("real-estate place slug 'all' collides with the chart's all-places scope");
    scopes[place.slug] = chartScope(
      slots.filter((s) => s.account_slug === place.slug),
      schemeByPlace,
      placeOrder
    );
  }
  return scopes;
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
  gastosLines: readonly FlowCcExpenseLineRow[],
  brokenLink: RealEstateBrokenLinkDto | undefined
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
    broken_link: brokenLink ?? null,
    display_amount_clp: displayAmountClp(exp.amount_clp, linkedLine),
    note: exp.note,
    kwh: exp.kwh,
    m3: exp.m3,
    months_covered: exp.months_covered,
    covers_from: addCalendarMonths(bill_month, 1 - exp.months_covered),
    mortgage_parts: null,
    can_link: exp.amount_clp > 0,
  };
}

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
}

function monthFromIndex(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export type MortgageCuotaPaymentRow = { occurred_on: string; cuota: string };

/**
 * Scheduled (billed) month per regular cuota, derived from the cuota numbers:
 * consecutive cuotas are consecutive months, so a single anchor — the modal value
 * of month(occurred_on) − cuotaN across rows — maps cuota N to anchor + N. A
 * skipped-then-caught-up payment shifts individual rows off the anchor without
 * moving the mode. Inconsistent evidence (non-numeric cuota, ambiguous anchor, a
 * payment > 3 months off schedule) throws — fix the depto_payments rows instead.
 */
export function mortgageCuotaBillMonths(rows: readonly MortgageCuotaPaymentRow[]): string[] {
  const cuotaNs = rows.map((r) => {
    const n = numericCuota(r.cuota);
    if (n == null) {
      throw new Error(`mortgage bill months: non-numeric regular cuota '${r.cuota}' (${r.occurred_on})`);
    }
    return n;
  });

  const anchorVotes = new Map<number, number>();
  rows.forEach((r, i) => {
    const anchor = monthIndex(monthKeyFromYmd(r.occurred_on)) - cuotaNs[i]!;
    anchorVotes.set(anchor, (anchorVotes.get(anchor) ?? 0) + 1);
  });
  // Mode wins; on a vote tie prefer the smallest anchor — payments run late
  // (the payable window opens on the 11th), never early, so the lower anchor is
  // the on-schedule one.
  let anchor: number | null = null;
  let best = 0;
  for (const [a, votes] of anchorVotes) {
    if (votes > best || (votes === best && anchor != null && a < anchor)) {
      anchor = a;
      best = votes;
    }
  }
  if (anchor == null) return [];

  const seen = new Set<number>();
  return rows.map((r, i) => {
    const idx = anchor + cuotaNs[i]!;
    const drift = monthIndex(monthKeyFromYmd(r.occurred_on)) - idx;
    if (drift < -1 || drift > 3) {
      throw new Error(
        `mortgage bill months: cuota ${cuotaNs[i]} paid ${r.occurred_on} is ${drift} months off its scheduled month ${monthFromIndex(idx)}`
      );
    }
    if (seen.has(idx)) {
      throw new Error(`mortgage bill months: duplicate scheduled month ${monthFromIndex(idx)} (cuota ${cuotaNs[i]})`);
    }
    seen.add(idx);
    return monthFromIndex(idx);
  });
}

/**
 * Monthly dividendo as read-only slots for every place linked to a property master
 * (`expense_accounts.property_account_id`), sourced from the depto ledger. Regular
 * cuotas only — pie and prepagos are capital events, not monthly expenses. Each cuota is
 * what was paid, split in `mortgage_parts`: the scheduled amortización, the extra amortization
 * paid above the minimum, and carrying (interés + seguros); the movement's `amount_clp` is an
 * equity mark, not the payment. Until 2026-10-28 the extra amortization was left out, so the
 * chart showed the minimum cuota. `bill_month` is the cuota's
 * scheduled month (billed-period framing); `spent_on` keeps the real payment date.
 */
function mortgageLedgerSlots(places: readonly RealEstatePlaceRow[]): RealEstateBillSlot[] {
  const linked = places.filter((p) => p.property_account_id != null);
  if (linked.length === 0) return [];

  const slots: RealEstateBillSlot[] = [];
  const stmt = db.prepare(
    `SELECT m.occurred_on, p.cuota,
            COALESCE(p.amortizacion_clp, 0) AS amortization_clp,
            COALESCE(p.amortizacion_ext_clp, 0) AS extra_amortization_clp,
            COALESCE(p.interes_clp, 0) + COALESCE(p.incendio_clp, 0) + COALESCE(p.desgravamen_clp, 0) AS carrying_clp
     FROM movements m
     JOIN depto_payments p ON p.movement_id = m.id
     WHERE m.account_id = ?
       AND p.kind = 'dividendos'
       AND LOWER(TRIM(p.cuota)) != 'pie'
       AND p.cuota NOT LIKE 'prepago%'
     ORDER BY m.occurred_on DESC`
  );
  for (const place of linked) {
    const rows = (
      stmt.all(place.property_account_id) as {
        occurred_on: string;
        cuota: string;
        amortization_clp: number;
        extra_amortization_clp: number;
        carrying_clp: number;
      }[]
    ).filter((r) => r.amortization_clp + r.extra_amortization_clp + r.carrying_clp > 0);
    const billMonths = mortgageCuotaBillMonths(rows);
    rows.forEach((r, i) => {
      const amortization = Math.round(r.amortization_clp);
      const extra = Math.round(r.extra_amortization_clp);
      const carrying = Math.round(r.carrying_clp);
      slots.push({
        expense_entry_id: null,
        account_slug: place.slug,
        bill_month: billMonths[i]!,
        spent_on: r.occurred_on,
        kind: "mortgage",
        expected_amount_clp: amortization + extra + carrying,
        link: null,
        broken_link: null,
        display_amount_clp: amortization + extra + carrying,
        note: null,
        kwh: null,
        m3: null,
        months_covered: 1,
        covers_from: billMonths[i]!,
        mortgage_parts: { amortization_clp: amortization, extra_amortization_clp: extra, carrying_clp: carrying },
        can_link: false,
      });
    });
  }
  return slots;
}

/**
 * Auto-links bills to their purchases. A stored link that no longer holds is kept and reported on
 * its bill (`broken_link`), never deleted on a read: a re-import that renamed the purchase would
 * otherwise erase the pairing silently.
 */
function ensureAutoLinks(
  expectations: readonly ExpenseExpectationRow[],
  gastosLines: readonly FlowCcExpenseLineRow[]
): Map<number, RealEstateLinkRow> {
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
  const expectations = listRealEstateExpectations();
  const gastosLines = loadGastosLinesForRealEstateMatching();
  const linksByEntry = ensureAutoLinks(expectations, gastosLines);

  const brokenByEntry = new Map(
    findInvalidRealEstateExpenseLinks(expectations, gastosLines, linksByEntry).map((l) => [
      l.expense_entry_id,
      { purchase_key: l.purchase_key, problem: l.problem } satisfies RealEstateBrokenLinkDto,
    ])
  );

  const slots = expectations
    .map((exp) => expectationToSlot(exp, linksByEntry.get(exp.id), gastosLines, brokenByEntry.get(exp.id)))
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

  const chart_scopes = buildChartScopes(slots, places);
  const total_clp = slots.reduce((s, sl) => s + sl.display_amount_clp, 0);

  return {
    places: places.map(placeToDto),
    slots,
    by_account,
    chart_scopes,
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
