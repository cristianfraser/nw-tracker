/**
 * The credit-card group page (`/liabilities/credit-card`): one lane per card on a shared date axis
 * (its owed amount, the open facturación's close and the pay-bys ahead, its cupo), the group's
 * totals, and «Upcoming payments». Every figure comes from each card's own glance
 * (`ccGlance.ts`), so a lane reads what the card's page reads; the client only picks and places.
 *
 * - owed per currency = the glance's cupo used per side; its total = the glance's `total_owed`
 *   (a single-currency card: the billing side's used);
 * - the last closed facturación still owing → a pay-by at what it owes (each currency at today's
 *   debt rate); the open one → its close and its pay-by at the bill so far (an estimate);
 * - cuotas ahead = the billing side's cuota segments.
 *
 * «Upcoming payments» puts those payments on their pay month: the closed bill still owing,
 * the open bill so far (and a next cycle's purchases on a close day), and each later facturación's
 * plan cuotas on its pay-by (`facturacionPayByIsoResolver`). Cuota purchases still waiting for their
 * count have no schedule, so the months add up to the owed amount less those.
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
import { billingCurrencyConverter, buildCcGlanceForAccount, type CcGlance } from "./ccGlance.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { facturacionPayByIsoResolver } from "./ccBillingViews.js";
import { resolveCcMasterAccountIds } from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { getAccountColorRgb } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { roundToCurrency } from "./displayUnits.js";
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

export type CcGroupLaneCardInput = {
  accountId: number;
  name: string;
  colorRgb: string;
  glance: CcGlance;
  /** The facturación's pay-by (ISO) for any billing month (`facturacionPayByIsoResolver`). */
  payByIso: (billingMonth: string) => string;
  /** The open facturación's pay-by, which the glance does not carry. */
  openPayByIso: string;
  /** `qty` of `currency` in the billing currency at today's debt rate (`billingCurrencyConverter`). */
  toBillingCurrency: (qty: number, currency: string) => number;
};

type Payment = { billing_month: string; pay_by_iso: string; amount: number; estimate: boolean; kind: "billed" | "open" };

function sumAmounts(lists: readonly (readonly CcGlanceAmountDto[])[], billing: string): CcGlanceAmountDto[] {
  const by = new Map<string, number>();
  for (const list of lists) for (const a of list) by.set(a.currency, (by.get(a.currency) ?? 0) + a.amount);
  const entries = [...by.entries()]
    .map(([currency, amount]) => ({ currency, amount: roundToCurrency(amount, currency) }))
    .filter((a) => a.currency === billing || a.amount !== 0);
  return [...entries.filter((a) => a.currency === billing), ...entries.filter((a) => a.currency !== billing)];
}

/** The lanes payload from each card's glance (pure: the DB readers are in `ccGroupLanesResponse`). */
export function ccGroupLanesFromInputs(
  cardsIn: readonly CcGroupLaneCardInput[],
  billing: string,
  today: string
): CcGroupLanesResponse {
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

    // The payments ahead, by date: the closed bill still owing, then the open bill so far.
    const payments: Payment[] = [];
    const prev = g.previous;
    if (prev && !prev.paid) {
      payments.push({
        billing_month: prev.billing_month,
        pay_by_iso: prev.pay_by_iso,
        amount: round(prev.owed.reduce((a, o) => a + c.toBillingCurrency(o.amount, o.currency), 0)),
        estimate: false,
        kind: "billed",
      });
    }
    payments.push({
      billing_month: g.open.billing_month,
      pay_by_iso: c.openPayByIso,
      amount: g.open.total,
      estimate: true,
      kind: "open",
    });
    // On a close day the next cycle's purchases are a bill of their own.
    for (const s of segments) {
      if (s.kind === "purchases" && s.billing_month > g.open.billing_month) {
        payments.push({ billing_month: s.billing_month, pay_by_iso: c.payByIso(s.billing_month), amount: s.amount, estimate: true, kind: "open" });
      }
    }

    const cupo =
      main.total != null && main.total > 0 ? { used: main.used, total: main.total, used_share: main.used / main.total } : null;
    return { c, g, owed, owedTotal, cuotasAhead, payments, cupo, segments };
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
    return {
      account_id: p.c.accountId,
      name: p.c.name,
      color_rgb: p.c.colorRgb,
      owed: p.owed,
      owed_total: p.owedTotal,
      previous: p.g.previous ? { billing_month: p.g.previous.billing_month, paid: p.g.previous.paid } : null,
      cuotas_ahead: p.cuotasAhead,
      cupo: p.cupo,
      next_payment: nextOf(p.c.accountId, p.payments[0]!),
      events: inWindow,
    };
  });
  cards.sort((a, b) => a.next_payment.pay_by_iso.localeCompare(b.next_payment.pay_by_iso) || a.account_id - b.account_id);

  // «Upcoming payments»: each payment and each later facturación's cuotas on its pay month.
  const months = new Map<string, CcGroupUpcomingMonthDto["parts"]>();
  const add = (iso: string, account_id: number, kind: "billed" | "open" | "cuotas", amount: number) => {
    if (amount === 0) return;
    const month = iso.slice(0, 7);
    const parts = months.get(month) ?? [];
    const same = parts.find((x) => x.account_id === account_id && x.kind === kind);
    if (same) same.amount = round(same.amount + amount);
    else parts.push({ account_id, kind, amount });
    months.set(month, parts);
  };
  for (const p of perCard) {
    for (const pay of p.payments) add(pay.pay_by_iso, p.c.accountId, pay.kind, pay.amount);
    for (const s of p.segments) {
      // The open month's cuotas are in its bill; later months' bill on their own pay-by.
      if (s.kind === "cuotas" && s.billing_month > p.g.open.billing_month) {
        add(p.c.payByIso(s.billing_month), p.c.accountId, "cuotas", s.amount);
      }
    }
  }
  const cardOrder = new Map(cards.map((c, i) => [c.account_id, i]));
  const kindOrder = { billed: 0, open: 1, cuotas: 2 } as const;
  const upcoming_months: CcGroupUpcomingMonthDto[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, parts]) => ({
      month,
      total: round(parts.reduce((a, x) => a + x.amount, 0)),
      parts: parts.sort(
        (a, b) => cardOrder.get(a.account_id)! - cardOrder.get(b.account_id)! || kindOrder[a.kind] - kindOrder[b.kind]
      ),
    }));

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
      next_payment: cards[0]?.next_payment ?? null,
    },
    cards,
    upcoming_months,
  };
}

/**
 * `GET /api/portfolio-groups/:slug/cc-lanes`: the cards the group ledger merges
 * (`resolveCcMasterAccountIds`) that still bill — a card that stopped billing has no glance, as on
 * its own page and in «Próximos pagos».
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
  const billingCurrencies = new Set<string>();
  const inputs: CcGroupLaneCardInput[] = [];
  for (const accountId of ids) {
    const billing = creditCardInstallmentsResponse(accountId).billing_currency;
    billingCurrencies.add(billing);
    const glance = buildCcGlanceForAccount(accountId, billing);
    if (glance == null) continue;
    const name = names.get(accountId);
    if (name == null) throw new Error(`Account ${accountId}: not a credit-card liability account`);
    const payByIso = facturacionPayByIsoResolver(accountId, billingDetailCacheForAccount(accountId).facturaciones);
    inputs.push({
      accountId,
      name,
      colorRgb: getAccountColorRgb(accountId),
      glance,
      payByIso,
      openPayByIso: payByIso(glance.open.billing_month),
      toBillingCurrency: billingCurrencyConverter(today, billing),
    });
  }
  if (billingCurrencies.size > 1) {
    throw new Error(`Group ${portfolioGroupSlug}: cards bill in ${[...billingCurrencies].join(", ")}; the lanes sum one currency`);
  }
  const billing = [...billingCurrencies][0];
  if (billing == null) throw new Error(`Group ${portfolioGroupSlug}: no credit-card accounts`);
  return ccGroupLanesFromInputs(inputs, billing, today);
}
