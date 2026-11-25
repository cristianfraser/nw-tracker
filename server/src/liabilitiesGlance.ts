/**
 * The Liabilities page (`GET /api/portfolio-groups/liabilities/liabilities-glance?unit=`): its head
 * and «Upcoming payments», composed from the two group pages' own payloads so every figure is one
 * those pages show, in the display unit:
 *
 * - the cards' owed = the credit-card group's lanes total (`ccGroupLanes.ts`), each currency at
 *   today's debt rate (`billingCurrencyConverter`, the conversion the lanes total a card with);
 * - the loans' balance = the mortgage group's glance (`mortgageGroupGlance.ts`);
 * - the financing-cost strip = the mortgage glance's strip plus the cards' dashboard rows (a card's
 *   P/L is its cost of financing, the same row its page's strip reads); a leg either group lacks is
 *   null, never a partial sum;
 * - upcoming payments: each card's month sum as the lanes put it (`by_card`: its payment on its pay
 *   month, later facturaciones' billed cuotas on their pay-bys) and each loan's cuotas as «Próximos pagos» lists them
 *   (`mortgageUpcomingMonthsByLoan`), both over that panel's horizon at today's mid rate, an overdue
 *   payment in the current month.
 *
 * The Pasivos tree holds the credit-card and the mortgage groups only; another liability kind throws.
 */
import { addCalendarMonths } from "nw-tracker-contracts";
import type {
  LiabilitiesGlanceDto,
  LiabilitiesUpcomingMonthDto,
  LiabilitiesUpcomingPartDto,
} from "nw-tracker-contracts/dto";
import { billingCurrencyConverter } from "./ccGlance.js";
import { ccGroupLanesResponse } from "./ccGroupLanes.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardAccountRow } from "./dashboardAccounts.js";
import { roundToCurrency } from "./displayUnits.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { buildMortgageGroupGlance, MORTGAGE_GROUP_SLUG } from "./mortgageGroupGlance.js";
import { liabilityGroups } from "./navTreeModel.js";
import { convertCurrency, type TsUnit } from "./rates.js";
import { mortgageUpcomingMonthsByLoan, UPCOMING_PAYMENTS_HORIZON_MONTHS } from "./upcomingPayments.js";

/** The page's node and its two groups. */
export const LIABILITIES_ROOT_SLUG = "liabilities";
export const CREDIT_CARD_GROUP_SLUG = "liabilities_credit_card";

const LIABILITY_KINDS = new Set(["credit_card", "mortgage"]);

type Strip = LiabilitiesGlanceDto["strip"];

/** Σ of the members that have the leg; null when none has it (`cardMetricsFromRows`' rule). */
function addLeg(a: number | null, b: number | null): number | null {
  return a == null ? b : b == null ? a : a + b;
}

function addStrips(a: Strip, b: Strip): Strip {
  return { day: addLeg(a.day, b.day), month: addLeg(a.month, b.month), year: addLeg(a.year, b.year), total: addLeg(a.total, b.total) };
}

/** Σ of the groups' strips: a leg is null when any group's is, never a partial sum (the mortgage group's rule). */
function addGroupStrips(a: Strip, b: Strip): Strip {
  const leg = (x: number | null, y: number | null) => (x == null || y == null ? null : x + y);
  return { day: leg(a.day, b.day), month: leg(a.month, b.month), year: leg(a.year, b.year), total: leg(a.total, b.total) };
}

/** Σ of the cards' dashboard rows (in `unit`): each card's financing cost per period. */
function cardsStrip(cardIds: readonly number[], unit: TsUnit): Strip {
  let out: Strip = { day: null, month: null, year: null, total: null };
  for (const id of cardIds) {
    const row = buildDashboardAccountRow(id, unit);
    if (row == null) throw new Error(`liabilities glance: card ${id} has no dashboard row`);
    out = addStrips(out, {
      day: row.delta_day ?? null,
      month: row.delta_month ?? null,
      year: row.delta_year ?? null,
      total: row.delta_total ?? null,
    });
  }
  return out;
}

/** The page payload; null for any slug but the Pasivos root. */
export async function buildLiabilitiesGlance(slug: string, unit: TsUnit): Promise<LiabilitiesGlanceDto | null> {
  if (slug !== LIABILITIES_ROOT_SLUG) return null;
  for (const g of liabilityGroups()) {
    if (g.liabilityKind != null && !LIABILITY_KINDS.has(g.liabilityKind)) {
      throw new Error(`liabilities glance: group ${g.slug} is a ${g.liabilityKind} liability; the page knows cards and mortgages`);
    }
  }
  const today = chileCalendarTodayYmd();
  const firstMonth = today.slice(0, 7);
  const lastMonth = addCalendarMonths(firstMonth, UPCOMING_PAYMENTS_HORIZON_MONTHS - 1);
  const midInUnit = (amount: number, from: string): number => {
    const v = convertCurrency(amount, from, unit, today, { side: "mid" });
    if (v == null || !Number.isFinite(v)) throw new Error(`liabilities glance: no ${from}→${unit} rate on ${today}`);
    return roundToCurrency(v, unit);
  };

  const months = new Map<string, { cards: LiabilitiesUpcomingPartDto[]; loans: LiabilitiesUpcomingPartDto[] }>();
  const monthOf = (month: string) => {
    const key = month < firstMonth ? firstMonth : month;
    if (key > lastMonth) return null;
    const m = months.get(key) ?? { cards: [], loans: [] };
    months.set(key, m);
    return m;
  };

  // Cards: the credit-card group page's lanes.
  const cardIds = listLiabilitiesTabAccountRows("credit_card").map((r) => r.account_id);
  let cards: LiabilitiesGlanceDto["cards"] = null;
  let strip: Strip | null = null;
  if (cardIds.length > 0) {
    const lanes = ccGroupLanesResponse(CREDIT_CARD_GROUP_SLUG);
    const toUnit = billingCurrencyConverter(today, unit);
    const owed = lanes.total.owed.reduce((a, o) => a + toUnit(o.amount, o.currency), 0);
    cards = { slug: CREDIT_CARD_GROUP_SLUG, owed: roundToCurrency(owed, unit), share: 0, count: lanes.cards.length };
    strip = cardsStrip(cardIds, unit);
    const cardOf = new Map(lanes.cards.map((c) => [c.account_id, c]));
    for (const um of lanes.upcoming_months) {
      const m = monthOf(um.month);
      if (m == null) continue;
      for (const b of um.by_card) {
        const card = cardOf.get(b.account_id);
        if (card == null) throw new Error(`liabilities glance: an upcoming payment of card ${b.account_id}, which has no lane`);
        const amount = midInUnit(b.amount, lanes.billing_currency);
        const prev = m.cards.find((x) => x.account_id === b.account_id);
        if (prev) {
          // An overdue month folded into the current one.
          prev.amount = roundToCurrency(prev.amount + amount, unit);
          prev.estimate ||= b.estimate;
        } else {
          m.cards.push({
            kind: "card",
            account_id: b.account_id,
            name: card.name,
            color_rgb: card.color_rgb,
            amount,
            amount_max: null,
            estimate: b.estimate,
          });
        }
      }
    }
  }

  // Loans: the mortgage group page's glance, and each loan's cuotas as «Próximos pagos» lists them.
  let mortgage: LiabilitiesGlanceDto["mortgage"] = null;
  if (listLiabilitiesTabAccountRows("mortgage").length > 0) {
    const glance = await buildMortgageGroupGlance(MORTGAGE_GROUP_SLUG, unit);
    if (glance == null) throw new Error(`liabilities glance: ${MORTGAGE_GROUP_SLUG} is not a mortgage group`);
    mortgage = { slug: MORTGAGE_GROUP_SLUG, balance: glance.balance, share: 0, count: glance.loans.length };
    const loansStrip: Strip = { day: glance.strip.day, month: glance.strip.month, year: glance.strip.year, total: glance.strip.total };
    strip = strip == null ? loansStrip : addGroupStrips(strip, loansStrip);
    const loanOf = new Map(glance.loans.map((l) => [l.account_id, l]));
    for (const { loanAccountId, months: loanMonths } of mortgageUpcomingMonthsByLoan(today, unit)) {
      const loan = loanOf.get(loanAccountId);
      if (loan == null) throw new Error(`liabilities glance: loan ${loanAccountId} has cuotas ahead but no row in ${MORTGAGE_GROUP_SLUG}`);
      for (const lm of loanMonths) {
        const m = monthOf(lm.pay_month);
        if (m == null) continue;
        for (const it of lm.items) {
          m.loans.push({
            kind: "mortgage",
            account_id: loanAccountId,
            name: loan.name,
            color_rgb: loan.color_rgb,
            amount: it.amount_in_unit,
            amount_max: it.amount_max_in_unit,
            estimate: it.estimated,
          });
        }
      }
    }
  }

  const upcoming_months: LiabilitiesUpcomingMonthDto[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => {
      const parts = [...m.loans, ...m.cards];
      const total = roundToCurrency(parts.reduce((a, p) => a + p.amount, 0), unit);
      return {
        month,
        total,
        total_max:
          m.loans.length === 0 ? null : roundToCurrency(parts.reduce((a, p) => a + (p.amount_max ?? p.amount), 0), unit),
        parts,
      };
    });

  const total = roundToCurrency((cards?.owed ?? 0) + (mortgage?.balance ?? 0), unit);
  const shareOf = (v: number) => (total > 0 ? v / total : 0);
  if (cards) cards.share = shareOf(cards.owed);
  if (mortgage) mortgage.share = shareOf(mortgage.balance);

  const leg = (v: number | null | undefined) => (v == null ? null : roundToCurrency(v, unit));
  return {
    unit,
    as_of: today,
    total,
    strip: { day: leg(strip?.day), month: leg(strip?.month), year: leg(strip?.year), total: leg(strip?.total) },
    cards,
    mortgage,
    upcoming_months,
  };
}
