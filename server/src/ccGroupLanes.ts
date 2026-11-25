/**
 * The credit-card group page (a credit-card liability group, `/liabilities/credit-card`): one lane
 * per card on a shared date axis (its owed amount, the open facturación's close and the pay-bys
 * ahead, its cupo), the group's totals, and «Upcoming payments». Each figure comes from the source
 * the card's own page or the home panel reads, so the three surfaces cannot drift; the client only
 * picks and places.
 *
 * - owed per currency, cupo and cuotas ahead: the card's glance (`ccGlance.ts`) — cupo used per
 *   side, `total_owed` (a single-currency card: the billing side's used), the cuota segments;
 * - the open facturación's close: the glance (the bill so far);
 * - payments: «Próximos pagos»' rows (`upcomingPaymentRows`, `dashboardCcUpcomingPayments.ts`), what
 *   each facturación still owes — the latest closed one less payments and the credits the bank
 *   applies to it, the open one net of what the closed one carries (credits given back, an
 *   overpayment taken off), a foreign amount at today's mid; a row owing nothing is not there;
 * - later cuotas: the card's «Cuotas por facturación» (`months` of the card payload), each
 *   facturación's billed cuotas (interest included) on its pay-by.
 *
 * «Upcoming payments» puts the payments and later cuotas on their pay month (an overdue bill in the
 * current month, as the home panel counts it), plus a next cycle's purchases on a close day. Cuota
 * purchases still waiting for their count have no schedule, so they are not in it.
 */
import { addDaysIso, daysBetweenIso } from "nw-tracker-contracts";
import type {
  CcGlanceAmountDto,
  CcGroupLaneCardDto,
  CcGroupLaneEventDto,
  CcGroupLanesResponse,
  CcGroupNextPaymentDto,
  CcGroupUpcomingMonthDto,
} from "nw-tracker-contracts/dto/creditCard";
import { buildCcGlanceForAccount, type CcGlance } from "./ccGlance.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { facturacionPayByIsoResolver } from "./ccBillingViews.js";
import {
  cardPayments,
  upcomingPaymentLiveRate,
  upcomingPaymentRows,
  type CcUpcomingPaymentRow,
} from "./dashboardCcUpcomingPayments.js";
import { resolveCcMasterAccountIds } from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { getAccountColorRgb } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { CARD_BILLING_CURRENCY } from "./cards/cardCurrencies.js";
import { cacheKeyCcLanesGroup } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { markJsonResponseCacheable } from "./jsonResponse.js";
import { dbInTransaction } from "./db.js";

/** Days the axis shows before today, so today and a just-overdue pay-by sit inside it. */
const AXIS_LEAD_DAYS = 3;
/** The axis reaches the latest open bill's pay-by, at least this far … */
const AXIS_MIN_DAYS = 30;
/** … and at most this far. */
const AXIS_MAX_DAYS = 62;
/** Tick spacing from today. */
const TICK_DAYS = 14;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type CcGroupLaneCardInput = {
  accountId: number;
  name: string;
  colorRgb: string;
  glance: CcGlance;
  /** «Próximos pagos»' rows of the card: what each facturación still owes, in pesos. */
  payments: readonly Pick<CcUpcomingPaymentRow, "billing_month" | "pay_by_iso" | "amount_clp" | "overdue" | "is_open_month">[];
  /** The open facturación's pay-by (`facturacionPayByIsoResolver`), which the glance does not carry. */
  openPayByIso: string;
  /** The facturación's pay-by (ISO) for any billing month: a next cycle's, on a close day. */
  payByIso: (billingMonth: string) => string;
  /** «Cuotas por facturación» (`months` of the card payload): each facturación's billed cuotas and pay-by. */
  cuotaMonths: readonly { month: string; total: number; pay_by_date: string }[];
};

type Payment = { billing_month: string; pay_by_iso: string; amount: number; estimate: boolean; overdue: boolean; kind: "billed" | "open" };

function sumAmounts(lists: readonly (readonly CcGlanceAmountDto[])[], billing: string): CcGlanceAmountDto[] {
  const by = new Map<string, number>();
  for (const list of lists) for (const a of list) by.set(a.currency, (by.get(a.currency) ?? 0) + a.amount);
  const entries = [...by.entries()]
    .map(([currency, amount]) => ({ currency, amount: roundToCurrency(amount, currency) }))
    .filter((a) => a.currency === billing || a.amount !== 0);
  return [...entries.filter((a) => a.currency === billing), ...entries.filter((a) => a.currency !== billing)];
}

/** The lanes payload from each card's sources (pure: the DB readers are in `ccGroupLanesResponse`). */
export function ccGroupLanesFromInputs(
  cardsIn: readonly CcGroupLaneCardInput[],
  billing: string,
  today: string
): CcGroupLanesResponse {
  // «Próximos pagos»' rows are pesos: the lanes sum them in the card billing frame.
  if (!isHomeCurrency(billing)) throw new Error(`Credit-card lanes: the cards bill in ${billing}, the payments are pesos`);
  const round = (v: number) => roundToCurrency(v, billing);

  const perCard = cardsIn.map((c) => {
    const g = c.glance;
    if (g.billing_currency !== billing) {
      throw new Error(`Account ${c.accountId}: bills in ${g.billing_currency}, the group in ${billing}`);
    }
    const main = g.sides[0];
    if (!main || main.currency !== billing) throw new Error(`Account ${c.accountId}: glance has no ${billing} side first`);
    const owed = g.sides
      .filter((s) => s.currency === billing || s.used !== 0)
      .map((s) => ({ currency: s.currency, amount: s.used }));
    const owedTotal = g.total_owed ?? main.used;
    const segments = main.segments ?? [];
    const cuotasAhead = round(segments.filter((s) => s.kind === "cuotas").reduce((a, s) => a + s.amount, 0));

    // The payments still owed, by date (an overdue one first), then a next cycle's bill on a close day.
    const payments: Payment[] = c.payments
      .filter((r) => r.amount_clp > 0)
      .map((r) => ({
        billing_month: r.billing_month,
        pay_by_iso: r.pay_by_iso,
        amount: r.amount_clp,
        estimate: r.is_open_month,
        overdue: r.overdue,
        kind: r.is_open_month ? ("open" as const) : ("billed" as const),
      }));
    for (const s of segments) {
      if (s.kind === "purchases" && s.billing_month > g.open.billing_month && s.amount > 0) {
        payments.push({ billing_month: s.billing_month, pay_by_iso: c.payByIso(s.billing_month), amount: s.amount, estimate: true, overdue: false, kind: "open" });
      }
    }
    payments.sort((a, b) => a.pay_by_iso.localeCompare(b.pay_by_iso));

    const laterCuotas = c.cuotaMonths.filter((m) => m.month > g.open.billing_month && m.total > 0);
    for (const m of laterCuotas) {
      if (!ISO_DAY.test(m.pay_by_date)) throw new Error(`Account ${c.accountId}: cuota month ${m.month} pay-by «${m.pay_by_date}» is not a day`);
    }

    const cupo =
      main.total != null && main.total > 0 ? { used: main.used, total: main.total, used_share: main.used / main.total } : null;
    return { c, g, owed, owedTotal, cuotasAhead, payments, laterCuotas, cupo };
  });

  // The axis: from a few days before today to the latest open bill's pay-by, within bounds.
  const latestOpenPayBy = perCard.reduce((m, p) => Math.max(m, daysBetweenIso(today, p.c.openPayByIso)), 0);
  const endDays = Math.min(AXIS_MAX_DAYS, Math.max(AXIS_MIN_DAYS, latestOpenPayBy + 1));
  const span = endDays + AXIS_LEAD_DAYS;
  const share = (days: number) => (Math.min(endDays, Math.max(-AXIS_LEAD_DAYS, days)) + AXIS_LEAD_DAYS) / span;
  const ticks: { iso: string; share: number }[] = [];
  for (let d = 0; d <= endDays; d += TICK_DAYS) ticks.push({ iso: addDaysIso(today, d), share: share(d) });

  const nextOf = (accountId: number, p: Payment): CcGroupNextPaymentDto => ({
    account_id: accountId,
    billing_month: p.billing_month,
    pay_by_iso: p.pay_by_iso,
    days: daysBetweenIso(today, p.pay_by_iso),
    amount: p.amount,
    estimate: p.estimate,
  });

  const cards: CcGroupLaneCardDto[] = perCard.map((p) => {
    const events: CcGroupLaneEventDto[] = [];
    const closeDays = daysBetweenIso(today, p.g.open.close_iso);
    events.push({
      kind: "close",
      billing_month: p.g.open.billing_month,
      iso: p.g.open.close_iso,
      days: closeDays,
      share: share(closeDays),
      amount: p.g.open.total,
      estimate: false,
    });
    for (const pay of p.payments) {
      const days = daysBetweenIso(today, pay.pay_by_iso);
      events.push({ kind: "pay_by", billing_month: pay.billing_month, iso: pay.pay_by_iso, days, share: share(days), amount: pay.amount, estimate: pay.estimate });
    }
    const inWindow = events
      .filter((e) => e.days <= endDays)
      .sort((a, b) => a.iso.localeCompare(b.iso) || (a.kind === "close" ? -1 : 1));
    const first = p.payments[0];
    return {
      account_id: p.c.accountId,
      name: p.c.name,
      color_rgb: p.c.colorRgb,
      owed: p.owed,
      owed_total: p.owedTotal,
      previous: p.g.previous ? { billing_month: p.g.previous.billing_month, paid: p.g.previous.paid } : null,
      cuotas_ahead: p.cuotasAhead,
      cupo: p.cupo,
      next_payment: first ? nextOf(p.c.accountId, first) : null,
      events: inWindow,
    };
  });
  // By next payment, idle cards last (in the Pasivos order they came in).
  cards.sort((a, b) => {
    if (a.next_payment == null || b.next_payment == null) return (a.next_payment == null ? 1 : 0) - (b.next_payment == null ? 1 : 0);
    return a.next_payment.pay_by_iso.localeCompare(b.next_payment.pay_by_iso);
  });

  // «Upcoming payments»: each payment and each later facturación's cuotas on its pay month.
  const todayMonth = today.slice(0, 7);
  const months = new Map<string, CcGroupUpcomingMonthDto["parts"]>();
  const add = (month: string, account_id: number, kind: "billed" | "open" | "cuotas", amount: number) => {
    if (amount === 0) return;
    const parts = months.get(month) ?? [];
    const same = parts.find((x) => x.account_id === account_id && x.kind === kind);
    if (same) same.amount = round(same.amount + amount);
    else parts.push({ account_id, kind, amount });
    months.set(month, parts);
  };
  for (const p of perCard) {
    for (const pay of p.payments) add(pay.overdue ? todayMonth : pay.pay_by_iso.slice(0, 7), p.c.accountId, pay.kind, pay.amount);
    for (const m of p.laterCuotas) add(m.pay_by_date.slice(0, 7), p.c.accountId, "cuotas", m.total);
  }
  const cardOrder = new Map(cards.map((c, i) => [c.account_id, i]));
  const kindOrder = { billed: 0, open: 1, cuotas: 2 } as const;
  const upcoming_months: CcGroupUpcomingMonthDto[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, parts]) => {
      parts.sort((a, b) => cardOrder.get(a.account_id)! - cardOrder.get(b.account_id)! || kindOrder[a.kind] - kindOrder[b.kind]);
      const by_card: CcGroupUpcomingMonthDto["by_card"] = [];
      for (const x of parts) {
        const last = by_card[by_card.length - 1];
        if (last && last.account_id === x.account_id) {
          last.amount = round(last.amount + x.amount);
          last.estimate ||= x.kind === "open";
        } else {
          by_card.push({ account_id: x.account_id, amount: x.amount, estimate: x.kind === "open" });
        }
      }
      return { month, total: round(parts.reduce((a, x) => a + x.amount, 0)), parts, by_card };
    });

  const allCupo = cards.every((c) => c.cupo != null) && cards.length > 0;
  const cupoUsed = round(cards.reduce((a, c) => a + (c.cupo?.used ?? 0), 0));
  const cupoTotal = round(cards.reduce((a, c) => a + (c.cupo?.total ?? 0), 0));
  return {
    billing_currency: billing,
    today_iso: today,
    axis: {
      start_iso: addDaysIso(today, -AXIS_LEAD_DAYS),
      end_iso: addDaysIso(today, endDays),
      days: span,
      today_share: share(0),
      ticks,
    },
    total: {
      owed: sumAmounts(cards.map((c) => c.owed), billing),
      owed_total: round(cards.reduce((a, c) => a + c.owed_total, 0)),
      cuotas_ahead: round(cards.reduce((a, c) => a + c.cuotas_ahead, 0)),
      cupo: allCupo ? { used: cupoUsed, total: cupoTotal, used_share: cupoUsed / cupoTotal } : null,
      next_payment: cards.find((c) => c.next_payment != null)?.next_payment ?? null,
    },
    cards,
    upcoming_months,
  };
}

/**
 * `GET /api/portfolio-groups/:slug/cc-lanes`: the cards the group ledger merges
 * (`resolveCcMasterAccountIds`) that still bill — a card that stopped billing has no glance, as on
 * its own page and in «Próximos pagos», and is not on the page (so it takes no part in the one
 * billing currency the lanes sum). A group with no billing card is an empty payload.
 */
export function ccGroupLanesResponse(portfolioGroupSlug: string): CcGroupLanesResponse {
  if (dbInTransaction()) return buildCcGroupLanes(portfolioGroupSlug);
  return getAggregationCached(cacheKeyCcLanesGroup(portfolioGroupSlug), () =>
    markJsonResponseCacheable(buildCcGroupLanes(portfolioGroupSlug))
  );
}

function buildCcGroupLanes(portfolioGroupSlug: string): CcGroupLanesResponse {
  const today = chileCalendarTodayYmd();
  const ids = resolveCcMasterAccountIds(portfolioGroupSlug);
  const names = new Map(listLiabilitiesTabAccountRows("credit_card").map((r) => [r.account_id, r.name]));
  const liveRate = upcomingPaymentLiveRate(today);
  const billingCurrencies = new Set<string>();
  const inputs: CcGroupLaneCardInput[] = [];
  for (const accountId of ids) {
    const ledger = creditCardInstallmentsResponse(accountId);
    const glance = buildCcGlanceForAccount(accountId, ledger.billing_currency);
    if (glance == null) continue;
    billingCurrencies.add(ledger.billing_currency);
    const name = names.get(accountId);
    if (name == null) throw new Error(`Account ${accountId}: not a credit-card liability account`);
    const facturaciones = billingDetailCacheForAccount(accountId).facturaciones;
    const payByIso = facturacionPayByIsoResolver(accountId, facturaciones);
    inputs.push({
      accountId,
      name,
      colorRgb: getAccountColorRgb(accountId),
      glance,
      payments: upcomingPaymentRows(facturaciones, cardPayments(accountId, facturaciones), today, liveRate),
      openPayByIso: payByIso(glance.open.billing_month),
      payByIso,
      cuotaMonths: ledger.months,
    });
  }
  if (billingCurrencies.size > 1) {
    throw new Error(`Group ${portfolioGroupSlug}: billing cards bill in ${[...billingCurrencies].join(", ")}; the lanes sum one currency`);
  }
  const billing = [...billingCurrencies][0] ?? CARD_BILLING_CURRENCY;
  return ccGroupLanesFromInputs(inputs, billing, today);
}
