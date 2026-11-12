import { openFacturacionCredits } from "./ccBillingBalances.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { cardStoppedBilling } from "./cards/lifecycle.js";
import { facturadoForeignIn, type CcFacturacionRow } from "./ccBillingViews.js";
import { listCcPaymentEvidenceRows } from "./ccPaymentMirrorEvidence.js";
import { cardForeignCurrencies, foreignDebtPaymentsForAccount } from "./ccFacturacionForeignRate.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { convertCurrency } from "./rates.js";
import { getLiabilitiesNavRootNode } from "./navTree.js";

/** One facturación still to pay (or still billing) on the dashboard's «próximos pagos» panel. */
export type CcUpcomingPaymentRow = {
  billing_month: string;
  close_date_iso: string;
  /** The close comes from the bank's own evidence (statement or feed SALDO INICIAL); false = announced or estimated. */
  close_observed: boolean;
  close_date_source: CcFacturacionRow["close_date_source"];
  pay_by_iso: string;
  pay_by_source: "statement" | "derived";
  /**
   * What is still owed on the facturación, in pesos: its pesos less the peso payments made since
   * its close, plus its dollars less the dollar payments, the dollars left at today's rate.
   */
  amount_clp: number;
  /**
   * What is still owed per currency the facturación bills in: the pesos (whole) and the dollars
   * (to the cent), each ≥ 0. `amount_clp` is their pesos; a display unit converts each one
   * (`upcomingMonthsInUnit`), never the dollars through pesos.
   */
  owed: Record<string, number>;
  /** The facturación's total in pesos (CLP + the dollars in pesos), as its facturaciones row shows it. */
  billed_clp: number;
  /** Its pay-by has passed with something still owed. */
  overdue: boolean;
  /** The open facturación: its amount still grows until the close. */
  is_open_month: boolean;
  is_provisional_close: boolean;
};

/** One card's facturación inside a pay month. */
export type CcUpcomingPayment = {
  account_id: number;
  name: string;
  row: CcUpcomingPaymentRow;
};

/** What is due in one pay month: its total and the payments that make it up. */
export type CcUpcomingPaymentsMonth = {
  /** YYYY-MM of the pay-by; an overdue row is due now, so it falls in the current month. */
  pay_month: string;
  total_clp: number;
  /** In card order (the cards' own order), each card's rows in facturación order. */
  payments: CcUpcomingPayment[];
};

export type CcUpcomingPaymentsBlock = {
  /** Pay months with something due, oldest first; empty = nothing to show (the panel hides). */
  months: CcUpcomingPaymentsMonth[];
  /** The Pasivos page's route, from the nav tree; null when the tree has no Pasivos root. */
  liabilities_route_path: string | null;
};

/** One payment of a card, in the currency of the debt it pays (pesos whole, a foreign currency to its coin). */
export type CcCardPayment = { date_iso: string; amount: number };

/**
 * A card's payments per debt currency (pesos, and each foreign currency it owes in), and the
 * credits of its open facturación per currency (refunds, notas de crédito: positive totals, see
 * `openFacturacionCredits`).
 */
export type CcCardPayments = {
  paid: Readonly<Record<string, readonly CcCardPayment[]>>;
  open_credits: Readonly<Record<string, number>>;
};

function paidAfter(payments: readonly CcCardPayment[] | undefined, closeIso: string): number {
  let sum = 0;
  for (const p of payments ?? []) if (p.date_iso > closeIso) sum += p.amount;
  return sum;
}

/** The foreign currencies a row of the card can owe in: its rows' entries, its payments' and credits' (dollars always). */
function foreignCurrenciesOf(facturaciones: readonly CcFacturacionRow[], payments: CcCardPayments): string[] {
  const out = new Set<string>(["usd"]);
  for (const f of facturaciones) for (const e of f.facturado_foreign) out.add(e.currency);
  for (const c of [...Object.keys(payments.paid), ...Object.keys(payments.open_credits)]) out.add(c);
  out.delete("clp");
  return [...out];
}

/**
 * The rows of one card the panel shows: the open facturación and the latest one before it (closed
 * by statement or provisionally), each with what is still owed on it; a row owing nothing is left out.
 *
 * Per currency (a dollar payment pays dollars, a euro payment euros), what the latest closed
 * facturación still owes is its amount less the payments made after its close and the credits the
 * open cycle has received (a nota de crédito after the close lowers what is left to pay, as the bank
 * applies it). The bank's next statement bills whatever an earlier facturación left unpaid, so only
 * the latest closed one can be owed. The open facturación's facturado already nets its credits, so
 * it gets back the ones the closed one used and loses what payments and credits put above the
 * closed one's amount (a credit the bank carries into the cycle). A closed facturación still owing
 * after its pay-by stays, marked overdue, until the next close bills it. A foreign currency still
 * owed is valued at `liveRate(currency)` (what it costs today, pesos per unit). Plan-only projected
 * months are not facturaciones rows, so they never appear.
 */
export function upcomingPaymentRows(
  facturaciones: readonly CcFacturacionRow[],
  payments: CcCardPayments,
  todayYmd: string,
  liveRate: (currency: string) => number
): CcUpcomingPaymentRow[] {
  // The open facturación is the latest one still open; the closed one is the latest before it. A
  // card with no close on record reads every month as open, so only the latest open one is.
  const byClose = [...facturaciones].sort((a, b) => a.close_date_iso.localeCompare(b.close_date_iso));
  let openRow: CcFacturacionRow | null = null;
  for (const f of byClose) if (f.is_open_month) openRow = f;
  let latestClosed: CcFacturacionRow | null = null;
  for (const f of byClose) {
    if (f === openRow) break;
    latestClosed = f;
  }
  const currencies = ["clp", ...foreignCurrenciesOf(facturaciones, payments)];

  const rates = new Map<string, number>();
  const pesosOf = (currency: string, amount: number): number => {
    if (isHomeCurrency(currency)) return amount;
    if (amount <= 0) return 0;
    let rate = rates.get(currency);
    if (rate == null) {
      rate = liveRate(currency);
      rates.set(currency, rate);
    }
    return Math.round(amount * rate);
  };
  const billedIn = (f: CcFacturacionRow, currency: string): number =>
    isHomeCurrency(currency) ? (f.facturado_clp ?? 0) : (facturadoForeignIn(f, currency)?.amount ?? 0);
  const out: CcUpcomingPaymentRow[] = [];
  const push = (f: CcFacturacionRow, owedBy: ReadonlyMap<string, number>): void => {
    const owed: Record<string, number> = {};
    let amount = 0;
    for (const c of currencies) {
      owed[c] = Math.max(0, roundToCurrency(owedBy.get(c) ?? 0, c));
      amount += pesosOf(c, owed[c]!);
    }
    if (amount <= 0) return;
    if (f.pay_by_iso == null || f.pay_by_source == null) {
      throw new Error(`Facturación ${f.billing_month} owes ${amount} and has no pay-by date`);
    }
    out.push({
      billing_month: f.billing_month,
      close_date_iso: f.close_date_iso,
      close_observed: f.close_date_source === "statement" || f.close_date_source === "feed",
      close_date_source: f.close_date_source,
      pay_by_iso: f.pay_by_iso,
      pay_by_source: f.pay_by_source,
      amount_clp: amount,
      owed,
      billed_clp: Math.round(f.facturado_total_clp ?? 0),
      overdue: f.pay_by_iso < todayYmd,
      is_open_month: f.is_open_month,
      is_provisional_close: f.is_provisional_close,
    });
  };

  // What the open facturación gets back (its netted credits the closed one used) or loses (what
  // went above the closed one's amount): the open cycle's credits less the closed one's excess.
  const openAdjust = new Map<string, number>();
  if (latestClosed != null) {
    const owedClosed = new Map<string, number>();
    for (const c of currencies) {
      const credits = payments.open_credits[c] ?? 0;
      const owed = billedIn(latestClosed, c) - paidAfter(payments.paid[c], latestClosed.close_date_iso) - credits;
      owedClosed.set(c, owed);
      openAdjust.set(c, credits - Math.max(0, -owed));
    }
    push(latestClosed, owedClosed);
  }
  if (openRow) {
    if (openRow.pay_by_iso == null) throw new Error(`Open facturación ${openRow.billing_month} has no pay-by date`);
    const open = openRow;
    push(open, new Map(currencies.map((c) => [c, billedIn(open, c) + (openAdjust.get(c) ?? 0)])));
  }
  return out;
}

/** Assembles the block from each card's rows (pure; the builder below feeds it from the DB). */
export function ccUpcomingPaymentsFromCards(
  cards: readonly {
    account_id: number;
    name: string;
    facturaciones: readonly CcFacturacionRow[];
    payments: CcCardPayments;
  }[],
  todayYmd: string,
  liveRate: (currency: string) => number,
  liabilitiesRoutePath: string | null
): CcUpcomingPaymentsBlock {
  const byMonth = new Map<string, CcUpcomingPaymentsMonth>();
  const todayMonth = todayYmd.slice(0, 7);
  for (const card of cards) {
    for (const row of upcomingPaymentRows(card.facturaciones, card.payments, todayYmd, liveRate)) {
      const payMonth = row.overdue ? todayMonth : row.pay_by_iso.slice(0, 7);
      const month = byMonth.get(payMonth) ?? { pay_month: payMonth, total_clp: 0, payments: [] };
      month.total_clp += row.amount_clp;
      month.payments.push({ account_id: card.account_id, name: card.name, row });
      byMonth.set(payMonth, month);
    }
  }
  const months = [...byMonth.values()].sort((a, b) => a.pay_month.localeCompare(b.pay_month));
  return { months, liabilities_route_path: liabilitiesRoutePath };
}

/**
 * A card's payments: the peso payments the card's own lines and statement headers show
 * (`listCcPaymentEvidenceRows`, one per payment — a line and the header naming the same payment
 * share a key), the dollar debt payments (`foreignDebtPaymentsForAccount`: divisas purchases,
 * payments from a dollar account, traspasos de deuda) and the open facturación's credits.
 */
function cardPayments(accountId: number, facturaciones: readonly CcFacturacionRow[]): CcCardPayments {
  const clp: CcCardPayment[] = [];
  const seen = new Set<string>();
  for (const e of listCcPaymentEvidenceRows(accountId)) {
    if (!isHomeCurrency(e.currency) || seen.has(e.key)) continue;
    seen.add(e.key);
    clp.push({ date_iso: e.pago_iso, amount: e.amount_clp });
  }
  const paid: Record<string, CcCardPayment[]> = { clp };
  // Dollars always (any card may pay a dollar debt), and every other currency the card bills in.
  for (const currency of new Set(["usd", ...cardForeignCurrencies(accountId)])) {
    paid[currency] = foreignDebtPaymentsForAccount(accountId, currency).map((p) => ({ date_iso: p.date_iso, amount: p.amount }));
  }
  const open = facturaciones.find((f) => f.is_open_month);
  const open_credits = open ? openFacturacionCredits(accountId, open.billing_month) : { clp: 0, usd: 0 };
  return { paid, open_credits };
}

const accountNameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);

/**
 * «Tarjetas: próximos pagos» on the home dashboard: per active card master (retired and superseded
 * cards never appear — the detalle's `cardStoppedBilling` rule), the facturaciones
 * still owed, read from the same cached rows the card page's facturaciones table shows
 * (`billingDetailCacheForAccount`) less the payments made since. Pesos only.
 */
export function buildDashboardCcUpcomingPayments(): CcUpcomingPaymentsBlock {
  const cards: {
    account_id: number;
    name: string;
    facturaciones: readonly CcFacturacionRow[];
    payments: CcCardPayments;
  }[] = [];
  for (const accountId of listCreditCardMasterAccountIds()) {
    if (cardStoppedBilling(accountId)) continue;
    const row = accountNameStmt.get(accountId) as { name: string } | undefined;
    if (!row) throw new Error(`Credit-card master ${accountId} not found`);
    const facturaciones = billingDetailCacheForAccount(accountId).facturaciones;
    cards.push({
      account_id: accountId,
      name: row.name,
      facturaciones,
      payments: cardPayments(accountId, facturaciones),
    });
  }
  const today = chileCalendarTodayYmd();
  return ccUpcomingPaymentsFromCards(
    cards,
    today,
    (currency) => {
      // Today's mid (live while the fx day is open), through `rates.ts`.
      const rate = convertCurrency(1, currency, "clp", today, { side: "mid" });
      if (rate == null || !(rate > 0)) throw new Error(`No ${currency.toUpperCase()}/CLP rate for ${today}`);
      return rate;
    },
    getLiabilitiesNavRootNode()?.route_path ?? null
  );
}
