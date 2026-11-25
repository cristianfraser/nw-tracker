/**
 * The credit-card page's «at a glance» block (`glance` on the card payload): the open facturación,
 * the previous one (paid, or what it still owes and by when) and the cupo per currency, with the
 * billing currency's used cupo split into the segments the page draws. Every figure is decided
 * here; the client only picks and formats.
 *
 * Sources, one definition each:
 * - the facturaciones rows (`billingDetailCacheForAccount`): the open facturación's amounts and
 *   close, the previous one's month, total, pay-by and provisional flag;
 * - «Próximos pagos» (`upcomingPaymentRows`, `dashboardCcUpcomingPayments.ts`): what each of the
 *   two still owes per currency — a closed facturación missing from its rows is paid;
 * - the cupo frame (`ccOwedByCurrency`): what the card uses per currency, the bank's «cupo
 *   utilizado» identity (closed facturado + unbilled plan principal + later lines), and the
 *   configured cupo per currency (`credit_card_cupos`); the bank's own snapshot is evidence for the
 *   nightly check and never drawn here;
 * - the plan remainder by billing month (`installmentRemainderByFacturacionClp`): one cuota segment
 *   per month, the open month first.
 *
 * The billing currency's segments are the previous facturación's unpaid part, the open cycle's
 * purchases (its owed amount less the cuotas it bills, plus the cuota purchases still waiting for
 * their count) and the cuota months. They must add up to the used cupo: a difference throws with
 * the figures, never a balancing segment.
 */
import { daysBetweenIso } from "nw-tracker-contracts";
import type { CcCardPayments } from "./dashboardCcUpcomingPayments.js";
import {
  cardPayments,
  openAndLatestClosedFacturacion,
  upcomingPaymentLiveRate,
  upcomingPaymentRows,
} from "./dashboardCcUpcomingPayments.js";
import {
  facturadoForeignIn,
  nextCycleOneShotNetClp,
  pendingCuotaPurchaseLines,
  type CcFacturacionRow,
  type CcPendingCuotaPurchase,
} from "./ccBillingViews.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { getCreditCardAccountConfig } from "./ccAccountConfig.js";
import { ccOwedByCurrency, type CcOwedByCurrency } from "./ccOwedByCurrency.js";
import { installmentRemainderByFacturacionClp } from "./ccInstallmentLedgerDb.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { convertCurrency } from "./rates.js";

export type CcGlanceAmount = { currency: string; amount: number };

export type CcGlanceSegment = {
  /**
   * `previous`: the previous facturación's unpaid part; `purchases`: the open cycle's (on a close day
   * also the next cycle's, its own month); `cuotas`: one billing month's plan cuotas.
   */
  kind: "previous" | "purchases" | "cuotas";
  /** The facturación the segment belongs to (`YYYY-MM`). */
  billing_month: string;
  amount: number;
  /** Its width on the bar: `amount` over the bar's scale. */
  share: number;
};

export type CcGlanceSide = {
  currency: string;
  /** What the card uses of its cupo in this currency (the cupo frame, `ccOwedByCurrency`). */
  used: number;
  /** The configured cupo; null when none is configured (an unconfigured cupo is not 0). */
  total: number | null;
  /** `total − used`; null without a configured cupo. */
  free: number | null;
  /** `used` over the bar's scale (the cupo, or `used` itself when it is larger or unconfigured). */
  used_share: number;
  /** The billing currency's segments, left to right (zero amounts left out); null on another currency. */
  segments: CcGlanceSegment[] | null;
  /**
   * The bracket over the open facturación's part of the bar (its purchases and its month's cuotas),
   * billing currency only: where it starts and how wide it is on the bar, and its label (the open
   * facturación's billing-currency amount; null on a single-currency card, whose large figure says it).
   */
  bracket: { start_share: number; share: number; amount: number | null } | null;
};

export type CcGlance = {
  billing_currency: string;
  open: {
    billing_month: string;
    /** The facturación so far, everything in the billing currency. */
    total: number;
    /** Its amount per currency side, billing currency first (shown only on a multi-currency card). */
    amounts: CcGlanceAmount[];
    close_iso: string;
    /** Calendar days from today (Chile) to the close. */
    days_to_close: number;
  };
  previous: {
    billing_month: string;
    /** Its total in the billing currency (the paid line shows it). */
    total: number;
    /** Nothing left to pay. */
    paid: boolean;
    /** What it still owes per currency, billing currency first, owed currencies only; empty when paid. */
    owed: CcGlanceAmount[];
    pay_by_iso: string;
    /** Calendar days from today (Chile) to the pay-by: negative when overdue. */
    days_to_pay_by: number;
    is_provisional_close: boolean;
  } | null;
  /** One entry per currency side, billing currency first. */
  sides: CcGlanceSide[];
  /** Σ of every side's used in the billing currency, at today's debt rate; null on a single-currency card. */
  total_owed: number | null;
};

export type CcGlanceInputs = {
  accountId: number;
  billingCurrency: string;
  today: string;
  facturaciones: readonly CcFacturacionRow[];
  payments: CcCardPayments;
  /** Today's mid, pesos per unit (what «Próximos pagos» values a foreign amount still owed at). */
  liveRate: (currency: string) => number;
  owed: CcOwedByCurrency;
  /** The unbilled plan principal by billing month after the latest close (`installmentRemainderByFacturacionClp`). */
  remainderByMonth: readonly { billing_month: string; amount_clp: number }[];
  pendingCuotaPurchases: readonly CcPendingCuotaPurchase[];
  /**
   * The next cycle's net one-shot pesos per month (`nextCycleOneShotNetClp`, a Santander close
   * day): never clamped, so the segments add up to the cupo frame's lines.
   */
  nextCycles: readonly { billing_month: string; net: number }[];
  /** The configured cupo per currency, the issuer's currencies first (`getCreditCardAccountConfig().cupo`). */
  cupos: readonly { currency: string; value: number | null }[];
  /** `qty` of `currency` in the billing currency at today's debt-side rate (credit at the asset side). */
  toBillingCurrency: (qty: number, currency: string) => number;
};

/** Billing currency first, then the rest in the order given. */
function billingFirst<T extends { currency: string }>(entries: readonly T[], billing: string): T[] {
  return [...entries.filter((e) => e.currency === billing), ...entries.filter((e) => e.currency !== billing)];
}

/** The block for one card; null when it has no open facturación (a card that stopped billing). */
export function ccGlanceFromInputs(inp: CcGlanceInputs): CcGlance | null {
  const billing = inp.billingCurrency;
  if (!isHomeCurrency(billing)) {
    // The cupo frame's plan side is pesos (`CcOwedByCurrency.clp`); another billing currency has no frame to draw.
    throw new Error(`Account ${inp.accountId}: the cupo frame has no plan side in ${billing}`);
  }
  const { open, latestClosed } = openAndLatestClosedFacturacion(inp.facturaciones);
  if (!open) return null;
  if (open.facturado == null || open.facturado_total == null) {
    throw new Error(`Account ${inp.accountId}: open facturación ${open.billing_month} has no facturado`);
  }

  const rows = upcomingPaymentRows(inp.facturaciones, inp.payments, inp.today, inp.liveRate);
  const owedOf = (f: CcFacturacionRow | null): Record<string, number> =>
    (f && rows.find((r) => r.billing_month === f.billing_month)?.owed) || {};
  const openOwed = owedOf(open);
  const closedOwed = owedOf(latestClosed);

  // Sides: the billing currency, then every currency with a configured cupo or something used in it.
  const usedBy = new Map<string, number>([[billing, inp.owed.clp.total]]);
  for (const [c, f] of Object.entries(inp.owed.foreign)) usedBy.set(c, f.total);
  const cupoBy = new Map(inp.cupos.map((c) => [c.currency, c.value]));
  const sideCurrencies = [billing];
  for (const c of [...inp.cupos.map((e) => e.currency), ...usedBy.keys()]) {
    if (sideCurrencies.includes(c)) continue;
    if ((cupoBy.get(c) ?? null) != null || (usedBy.get(c) ?? 0) !== 0) sideCurrencies.push(c);
  }
  const multi = sideCurrencies.length > 1;

  // The billing currency's segments.
  const lastClosed = inp.owed.last_closed_billing_month;
  if ((latestClosed?.billing_month ?? null) !== lastClosed) {
    throw new Error(
      `Account ${inp.accountId}: the cupo frame's last close ${lastClosed ?? "none"} is not the facturación ` +
        `before the open one (${latestClosed?.billing_month ?? "none"})`
    );
  }
  const previousUnpaid = closedOwed[billing] ?? 0;
  const taggedCuotaPurchases = inp.pendingCuotaPurchases
    .filter((p) => lastClosed == null || p.billing_month > lastClosed)
    .reduce((s, p) => s + p.amount, 0);
  const purchases = (openOwed[billing] ?? 0) - (open.cuota_a_pagar ?? 0) + taggedCuotaPurchases;
  const cuotaMonths = inp.remainderByMonth.filter((m) => m.amount_clp !== 0);
  const segAmounts: Omit<CcGlanceSegment, "share">[] = [];
  if (previousUnpaid !== 0 && latestClosed) {
    segAmounts.push({ kind: "previous", billing_month: latestClosed.billing_month, amount: previousUnpaid });
  }
  if (purchases !== 0) segAmounts.push({ kind: "purchases", billing_month: open.billing_month, amount: purchases });
  for (const m of cuotaMonths) segAmounts.push({ kind: "cuotas", billing_month: m.billing_month, amount: m.amount_clp });
  // On a Santander close day a purchase dated that day already bills the next cycle: its own
  // purchases segment, right after the open facturación's segments (outside its bracket). A
  // cycle whose credits outweigh its purchases lowers what is owed before it: the open cycle's
  // purchases first, then the previous facturación's unpaid part.
  for (const next of inp.nextCycles) {
    if (next.net > 0) {
      let at = 0;
      segAmounts.forEach((s, i) => {
        if (s.kind === "previous" || s.billing_month === open.billing_month) at = i + 1;
      });
      segAmounts.splice(at, 0, { kind: "purchases", billing_month: next.billing_month, amount: next.net });
      continue;
    }
    let credit = -next.net;
    for (const kind of ["purchases", "previous"] as const) {
      const seg = segAmounts.find((s) => s.kind === kind && (kind === "previous" || s.billing_month === open.billing_month));
      if (!seg || credit === 0) continue;
      const used = Math.min(seg.amount, credit);
      seg.amount -= used;
      credit -= used;
    }
    if (credit !== 0) {
      throw new Error(
        `Account ${inp.accountId}: the next cycle ${next.billing_month}'s credits (${-next.net}) exceed the open and previous facturaciones`
      );
    }
  }
  for (let i = segAmounts.length - 1; i >= 0; i--) if (segAmounts[i]!.amount === 0) segAmounts.splice(i, 1);
  const negative = segAmounts.find((s) => s.amount < 0);
  if (negative) {
    throw new Error(
      `Account ${inp.accountId}: glance segment ${negative.kind} ${negative.billing_month} is negative (${negative.amount})`
    );
  }
  const usedBilling = inp.owed.clp.total;
  const segSum = segAmounts.reduce((s, x) => s + x.amount, 0);
  if (segSum !== usedBilling) {
    throw new Error(
      `Account ${inp.accountId}: the glance segments add up to ${segSum} (previous unpaid ${previousUnpaid}, ` +
        `purchases ${purchases}, cuotas ${segSum - previousUnpaid - purchases}) but the cupo frame uses ${usedBilling} ` +
        `(closed facturado ${inp.owed.clp.facturado}, later lines ${inp.owed.clp.open_cycle_lines}, ` +
        `plan remainder ${inp.owed.clp.installment_remainder})`
    );
  }

  const sides: CcGlanceSide[] = sideCurrencies.map((currency) => {
    const used = usedBy.get(currency) ?? 0;
    const total = cupoBy.get(currency) ?? null;
    const scale = Math.max(total ?? 0, used);
    const share = (amount: number): number => (scale > 0 ? amount / scale : 0);
    const side: CcGlanceSide = {
      currency,
      used,
      total,
      free: total == null ? null : roundToCurrency(total - used, currency),
      used_share: share(used),
      segments: null,
      bracket: null,
    };
    if (currency !== billing) return side;
    side.segments = segAmounts.map((s) => ({ ...s, share: share(s.amount) }));
    // The bracket spans the open facturación's segments: its purchases and its own month's cuotas.
    let start = 0;
    let width = 0;
    let started = false;
    for (const s of side.segments) {
      const inOpen = (s.kind === "purchases" || s.kind === "cuotas") && s.billing_month === open.billing_month;
      if (inOpen) {
        started = true;
        width += s.share;
      } else if (!started) {
        start += s.share;
      }
    }
    side.bracket = started ? { start_share: start, share: width, amount: multi ? open.facturado : null } : null;
    return side;
  });

  const foreignAmounts = (f: CcFacturacionRow): CcGlanceAmount[] =>
    sideCurrencies
      .filter((c) => c !== billing)
      .map((c) => ({ currency: c, amount: roundToCurrency(facturadoForeignIn(f, c)?.amount ?? 0, c) }));

  let previous: CcGlance["previous"] = null;
  if (latestClosed) {
    if (latestClosed.pay_by_iso == null) {
      throw new Error(`Account ${inp.accountId}: facturación ${latestClosed.billing_month} has no pay-by date`);
    }
    const owed = billingFirst(
      Object.entries(closedOwed)
        .filter(([, amount]) => amount > 0)
        .map(([currency, amount]) => ({ currency, amount })),
      billing
    );
    previous = {
      billing_month: latestClosed.billing_month,
      total: latestClosed.facturado_total ?? 0,
      paid: owed.length === 0,
      owed,
      pay_by_iso: latestClosed.pay_by_iso,
      days_to_pay_by: daysBetweenIso(inp.today, latestClosed.pay_by_iso),
      is_provisional_close: latestClosed.is_provisional_close,
    };
  }

  const total_owed = multi
    ? roundToCurrency(
        sides.reduce((s, side) => s + (side.currency === billing ? side.used : inp.toBillingCurrency(side.used, side.currency)), 0),
        billing
      )
    : null;

  return {
    billing_currency: billing,
    open: {
      billing_month: open.billing_month,
      total: open.facturado_total,
      amounts: [{ currency: billing, amount: open.facturado }, ...foreignAmounts(open)],
      close_iso: open.close_date_iso,
      days_to_close: daysBetweenIso(inp.today, open.close_date_iso),
    },
    previous,
    sides,
    total_owed,
  };
}

/**
 * The block for a card master as of today (Chile day), from the DB; null for a card that stopped
 * billing (the «Próximos pagos» rule: it has no open cycle to show).
 */
export function buildCcGlanceForAccount(accountId: number, billingCurrency: string): CcGlance | null {
  if (cardStoppedBilling(accountId)) return null;
  const today = chileCalendarTodayYmd();
  const facturaciones = billingDetailCacheForAccount(accountId).facturaciones;
  const owed = ccOwedByCurrency(accountId, today);
  return ccGlanceFromInputs({
    accountId,
    billingCurrency,
    today,
    facturaciones,
    payments: cardPayments(accountId, facturaciones),
    liveRate: upcomingPaymentLiveRate(today),
    owed,
    remainderByMonth: installmentRemainderByFacturacionClp(accountId, owed.last_closed_billing_month, today),
    pendingCuotaPurchases: pendingCuotaPurchaseLines(accountId),
    nextCycles: facturaciones
      .filter((f) => f.is_next_cycle)
      .map((f) => ({ billing_month: f.billing_month, net: nextCycleOneShotNetClp(accountId, f.billing_month) })),
    cupos: getCreditCardAccountConfig(accountId).cupo,
    toBillingCurrency: billingCurrencyConverter(today, billingCurrency),
  });
}

/**
 * `qty` of `currency` in the billing currency at `today`'s debt-side rate (credit at the asset
 * side): the conversion the glance totals a card's sides with (`total_owed`), and the Liabilities page
 * values the cards' owed with (`liabilitiesGlance.ts`).
 */
export function billingCurrencyConverter(today: string, billingCurrency: string): (qty: number, currency: string) => number {
  return (qty, currency) => {
    if (currency === billingCurrency) return qty;
    const v = convertCurrency(qty, currency, billingCurrency, today, { side: qty < 0 ? "asset" : "debt" });
    if (v == null) throw new Error(`No ${currency.toUpperCase()}/${billingCurrency.toUpperCase()} rate for ${today}`);
    return v;
  };
}
