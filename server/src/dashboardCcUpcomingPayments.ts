import { openFacturacionCredits } from "./ccBillingBalances.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import { listCcPaymentEvidenceRows } from "./ccPaymentMirrorEvidence.js";
import { usdDebtPaymentsForAccount } from "./ccFacturacionUsdRate.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { fxForLiveMtm } from "./fxLive.js";
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
  /** The facturación's total in pesos (CLP + the dollars in pesos), as its facturaciones row shows it. */
  billed_clp: number;
  /** Its pay-by has passed with something still owed. */
  overdue: boolean;
  /** The open facturación: its amount still grows until the close. */
  is_open_month: boolean;
  is_provisional_close: boolean;
};

export type CcUpcomingPaymentsCard = {
  account_id: number;
  name: string;
  rows: CcUpcomingPaymentRow[];
};

export type CcUpcomingPaymentsBlock = {
  /** Active cards with something pending; empty = nothing to show (the panel hides). */
  cards: CcUpcomingPaymentsCard[];
  /**
   * Σ of the listed rows per pay-by month (YYYY-MM of `pay_by_iso`), oldest first: what is due each
   * month. An overdue row is due now, so it counts in the current month.
   */
  totals_by_month: { pay_month: string; total_clp: number }[];
  /** The Pasivos page's route, from the nav tree; null when the tree has no Pasivos root. */
  liabilities_route_path: string | null;
};

/** One payment of a card, in the currency of the debt it pays (pesos, or dollars to the cent). */
export type CcCardPayment = { date_iso: string; amount: number };

/**
 * A card's payments per debt currency, and the credits of its open facturación (refunds, notas de
 * crédito: positive totals, see `openFacturacionCredits`).
 */
export type CcCardPayments = {
  clp: readonly CcCardPayment[];
  usd: readonly CcCardPayment[];
  open_credits: { clp: number; usd: number };
};

function paidAfter(payments: readonly CcCardPayment[], closeIso: string): number {
  let sum = 0;
  for (const p of payments) if (p.date_iso > closeIso) sum += p.amount;
  return sum;
}

function centsOf(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * The rows of one card the panel shows: the open facturación and the latest one before it (closed
 * by statement or provisionally), each with what is still owed on it; a row owing nothing is left out.
 *
 * Per currency (a dollar payment pays dollars), what the latest closed facturación still owes is
 * its amount less the payments made after its close and the credits the open cycle has received
 * (a nota de crédito after the close lowers what is left to pay, as the bank applies it). The
 * bank's next statement bills whatever an earlier facturación left unpaid, so only the latest
 * closed one can be owed. The open facturación's facturado already nets its credits, so it gets
 * back the ones the closed one used and loses what payments and credits put above the closed
 * one's amount (a credit the bank carries into the cycle). A closed facturación still owing
 * after its pay-by stays, marked overdue, until the next close bills it. Dollars still owed are
 * valued at `liveUsdRate()` (what they cost today). Plan-only projected months are not
 * facturaciones rows, so they never appear.
 */
export function upcomingPaymentRows(
  facturaciones: readonly CcFacturacionRow[],
  payments: CcCardPayments,
  todayYmd: string,
  liveUsdRate: () => number
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

  let rate: number | null = null;
  const pesosOfDollars = (usd: number): number => {
    if (usd <= 0) return 0;
    rate ??= liveUsdRate();
    return Math.round(usd * rate);
  };
  const out: CcUpcomingPaymentRow[] = [];
  const push = (f: CcFacturacionRow, owedClp: number, owedUsd: number): void => {
    const amount = Math.max(0, Math.round(owedClp)) + pesosOfDollars(centsOf(owedUsd));
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
      billed_clp: Math.round(f.facturado_total_clp ?? 0),
      overdue: f.pay_by_iso < todayYmd,
      is_open_month: f.is_open_month,
      is_provisional_close: f.is_provisional_close,
    });
  };

  // What the open facturación gets back (its netted credits the closed one used) or loses (what
  // went above the closed one's amount): the open cycle's credits less the closed one's excess.
  let openAdjustClp = 0;
  let openAdjustUsd = 0;
  if (latestClosed != null) {
    const { clp: creditsClp, usd: creditsUsd } = payments.open_credits;
    const owedClp =
      (latestClosed.facturado_clp ?? 0) - paidAfter(payments.clp, latestClosed.close_date_iso) - creditsClp;
    const owedUsd =
      (latestClosed.facturado_usd ?? 0) - paidAfter(payments.usd, latestClosed.close_date_iso) - creditsUsd;
    openAdjustClp = creditsClp - Math.max(0, -owedClp);
    openAdjustUsd = creditsUsd - Math.max(0, -owedUsd);
    push(latestClosed, owedClp, owedUsd);
  }
  if (openRow) {
    if (openRow.pay_by_iso == null) throw new Error(`Open facturación ${openRow.billing_month} has no pay-by date`);
    push(openRow, (openRow.facturado_clp ?? 0) + openAdjustClp, (openRow.facturado_usd ?? 0) + openAdjustUsd);
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
  liveUsdRate: () => number,
  liabilitiesRoutePath: string | null
): CcUpcomingPaymentsBlock {
  const outCards: CcUpcomingPaymentsCard[] = [];
  const totals = new Map<string, number>();
  const todayMonth = todayYmd.slice(0, 7);
  for (const card of cards) {
    const rows = upcomingPaymentRows(card.facturaciones, card.payments, todayYmd, liveUsdRate);
    if (rows.length === 0) continue;
    for (const r of rows) {
      const payMonth = r.overdue ? todayMonth : r.pay_by_iso.slice(0, 7);
      totals.set(payMonth, (totals.get(payMonth) ?? 0) + r.amount_clp);
    }
    outCards.push({ account_id: card.account_id, name: card.name, rows });
  }
  const totals_by_month = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pay_month, total_clp]) => ({ pay_month, total_clp }));
  return { cards: outCards, totals_by_month, liabilities_route_path: liabilitiesRoutePath };
}

/**
 * A card's payments: the peso payments the card's own lines and statement headers show
 * (`listCcPaymentEvidenceRows`, one per payment — a line and the header naming the same payment
 * share a key), the dollar debt payments (`usdDebtPaymentsForAccount`: divisas purchases,
 * payments from a dollar account, traspasos de deuda) and the open facturación's credits.
 */
function cardPayments(accountId: number, facturaciones: readonly CcFacturacionRow[]): CcCardPayments {
  const clp: CcCardPayment[] = [];
  const seen = new Set<string>();
  for (const e of listCcPaymentEvidenceRows(accountId)) {
    if (e.currency !== "clp" || seen.has(e.key)) continue;
    seen.add(e.key);
    clp.push({ date_iso: e.pago_iso, amount: e.amount_clp });
  }
  const usd = usdDebtPaymentsForAccount(accountId).map((p) => ({ date_iso: p.date_iso, amount: p.usd }));
  const open = facturaciones.find((f) => f.is_open_month);
  const open_credits = open ? openFacturacionCredits(accountId, open.billing_month) : { clp: 0, usd: 0 };
  return { clp, usd, open_credits };
}

const accountNameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);

/**
 * «Tarjetas: próximos pagos» on the home dashboard: per active card master (retired and superseded
 * cards never appear — the detalle's `creditCardBillingDetailInactive` rule), the facturaciones
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
    if (creditCardBillingDetailInactive(accountId)) continue;
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
    () => {
      const fx = fxForLiveMtm(today);
      if (!fx) throw new Error(`No USD/CLP rate for ${today}`);
      return fx.clp_per_usd;
    },
    getLiabilitiesNavRootNode()?.route_path ?? null
  );
}
