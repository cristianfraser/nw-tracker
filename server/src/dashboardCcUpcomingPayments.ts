import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
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
  /** The facturación's total in pesos (CLP + the dollars in pesos), as its facturaciones row shows it. */
  amount_clp: number;
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
  /** Σ of the listed rows per pay-by month (YYYY-MM of `pay_by_iso`), oldest first: what is due each month. */
  totals_by_month: { pay_month: string; total_clp: number }[];
  /** The Pasivos page's route, from the nav tree; null when the tree has no Pasivos root. */
  liabilities_route_path: string | null;
};

/**
 * The rows of one card the panel shows: every facturación whose pay-by is today or later (the
 * Chile day, the clock «Cuotas por facturación» rolls off with), the open one included, with a
 * non-zero total. Plan-only projected months are not facturaciones rows, so they never appear.
 * A row whose pay-by is still ahead cannot be told from a paid one here (the facturaciones rows
 * carry no settled flag), so a facturación paid early stays until its pay-by passes.
 */
export function upcomingPaymentRows(
  facturaciones: readonly CcFacturacionRow[],
  todayYmd: string
): CcUpcomingPaymentRow[] {
  const out: CcUpcomingPaymentRow[] = [];
  for (const f of facturaciones) {
    if (f.pay_by_iso == null || f.pay_by_source == null) {
      if (f.is_open_month) {
        throw new Error(`Open facturación ${f.billing_month} has no pay-by date`);
      }
      continue;
    }
    if (f.pay_by_iso < todayYmd) continue;
    const amount = f.facturado_total_clp;
    if (amount == null || amount === 0) continue;
    out.push({
      billing_month: f.billing_month,
      close_date_iso: f.close_date_iso,
      close_observed: f.close_date_source === "statement" || f.close_date_source === "feed",
      close_date_source: f.close_date_source,
      pay_by_iso: f.pay_by_iso,
      pay_by_source: f.pay_by_source,
      amount_clp: Math.round(amount),
      is_open_month: f.is_open_month,
      is_provisional_close: f.is_provisional_close,
    });
  }
  out.sort((a, b) => a.billing_month.localeCompare(b.billing_month));
  return out;
}

/** Assembles the block from each card's rows (pure; the builder below feeds it from the DB). */
export function ccUpcomingPaymentsFromCards(
  cards: readonly { account_id: number; name: string; facturaciones: readonly CcFacturacionRow[] }[],
  todayYmd: string,
  liabilitiesRoutePath: string | null
): CcUpcomingPaymentsBlock {
  const outCards: CcUpcomingPaymentsCard[] = [];
  const totals = new Map<string, number>();
  for (const card of cards) {
    const rows = upcomingPaymentRows(card.facturaciones, todayYmd);
    if (rows.length === 0) continue;
    for (const r of rows) {
      const payMonth = r.pay_by_iso.slice(0, 7);
      totals.set(payMonth, (totals.get(payMonth) ?? 0) + r.amount_clp);
    };
    outCards.push({ account_id: card.account_id, name: card.name, rows });
  }
  const totals_by_month = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pay_month, total_clp]) => ({ pay_month, total_clp }));
  return { cards: outCards, totals_by_month, liabilities_route_path: liabilitiesRoutePath };
}

const accountNameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);

/**
 * «Tarjetas: próximos pagos» on the home dashboard: per active card master (retired and superseded
 * cards never appear — the detalle's `creditCardBillingDetailInactive` rule), the facturaciones
 * still to pay, read from the same cached rows the card page's facturaciones table shows
 * (`billingDetailCacheForAccount`). Pesos only: the facturaciones rows carry no USD frame.
 */
export function buildDashboardCcUpcomingPayments(): CcUpcomingPaymentsBlock {
  const cards: { account_id: number; name: string; facturaciones: readonly CcFacturacionRow[] }[] = [];
  for (const accountId of listCreditCardMasterAccountIds()) {
    if (creditCardBillingDetailInactive(accountId)) continue;
    const row = accountNameStmt.get(accountId) as { name: string } | undefined;
    if (!row) throw new Error(`Credit-card master ${accountId} not found`);
    cards.push({
      account_id: accountId,
      name: row.name,
      facturaciones: billingDetailCacheForAccount(accountId).facturaciones,
    });
  }
  return ccUpcomingPaymentsFromCards(
    cards,
    chileCalendarTodayYmd(),
    getLiabilitiesNavRootNode()?.route_path ?? null
  );
}
