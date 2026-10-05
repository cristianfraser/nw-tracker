/**
 * Finds a card's facturado paid with cuota purchases on another card, and records it the way the
 * user would by hand: the facturado-financing link (`ccFacturadoFinancingLinksDb.ts`) and, on the
 * paid card, the PAGO line its daily feed would have shown (BCI has none — its payment otherwise
 * waits for the next statement, counting the debt on both cards meanwhile).
 *
 * The evidence: on one day, one or more cuota purchases on another card whose principals add up,
 * to the peso, to a closed facturado still within its payment window (after its close, up to ten
 * days past its pay-by). Real cases: ·0101's June 2026 facturado (2.xxx.xxx) paid as two
 * purchases on 2026-06-30 (1.xxx.xxx + 1.xxx.xxx), its August one (1.xxx.xxx) as one on
 * 2026-08-28. The merchant is not used — it names wherever the payment was made.
 *
 * A cuota purchase is a plan (`cc_installment_purchases`, any source; principal printed by its
 * statement when it carries interest, else its total) or a feed line tagged as a cuota purchase
 * whose count is not known yet (`cuota_purchase_kind`; no plan, so no link until there is one —
 * but the PAGO is planted). Only one exact combination may fit: two that fit, or a purchase that
 * fits two facturados, is reported and left alone. Months already linked are never touched.
 *
 * The PAGO is planted only when the paid card holds no payment of that amount around the
 * purchase date (lines dated −3…+5 days, or a statement header naming the amount): the statement
 * that later prints the real PAGO settles the planted bucket line like any pasted one.
 */
import { importCcWebPasteLines } from "./accountImports.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { statementFacturadoClpForBillingMonth } from "./ccFacturadoFinancingProjectionLines.js";
import { listCcFacturadoFinancingLinks, upsertCcFacturadoFinancingLink } from "./ccFacturadoFinancingLinksDb.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { normalizeTransactionDateIso, parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { isPdfStatementSource } from "./ccManualBillingMonth.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import { ddMmYyyyFromIso } from "./ccBillingCloses.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";

/** Days past the pay-by a payment still counts toward the facturado (late payments happen). */
const PAY_BY_GRACE_DAYS = 10;
/** A day with more cuota purchases than this is not searched (2^n combinations). */
const MAX_PURCHASES_PER_DAY = 10;

type Payment =
  | { kind: "plan"; account_id: number; iso: string; principal_clp: number; plan_id: number; purchase_key: string }
  | { kind: "tagged_line"; account_id: number; iso: string; principal_clp: number; line_id: number };

type FinancedFacturado = {
  account_id: number;
  billing_month: string;
  facturado_clp: number;
  close_iso: string;
  pay_by_iso: string;
};

export type FacturadoFinancingMatch = {
  financed_account_id: number;
  financed_billing_month: string;
  facturado_clp: number;
  paid_on: string;
  payments: Payment[];
  /** `link`: every payment is a plan; `pending_plan`: a tagged line has no plan yet. */
  status: "link" | "pending_plan";
  /** Whether the paid card already shows the payment. */
  payment_on_file: boolean;
};

export type FacturadoFinancingPlan = {
  matches: FacturadoFinancingMatch[];
  ambiguous: { financed_account_id: number; financed_billing_month: string; reason: string }[];
};

function financedFacturados(linked: Set<string>): FinancedFacturado[] {
  const out: FinancedFacturado[] = [];
  for (const accountId of listCreditCardMasterAccountIds()) {
    const rows = db
      .prepare(
        `SELECT statement_date, pay_by, source_pdf FROM cc_statements
         WHERE account_id = ? AND currency = 'clp' AND monto_facturado > 0`
      )
      .all(accountId) as { statement_date: string; pay_by: string | null; source_pdf: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!isPdfStatementSource(r.source_pdf)) continue;
      const closeIso = parseDdMmYyToIso(r.statement_date);
      const payByIso = r.pay_by ? parseDdMmYyToIso(r.pay_by) : null;
      if (!closeIso || !payByIso) continue;
      const month = billingMonthForStatementDate(closeIso);
      if (!month || seen.has(month) || linked.has(`${accountId}|${month}`)) continue;
      seen.add(month);
      const facturado = statementFacturadoClpForBillingMonth(accountId, month);
      if (facturado == null || facturado <= 0) continue;
      out.push({ account_id: accountId, billing_month: month, facturado_clp: facturado, close_iso: closeIso, pay_by_iso: payByIso });
    }
  }
  return out;
}

function cuotaPayments(linkedKeys: Set<string>): Payment[] {
  const out: Payment[] = [];
  const plans = db
    .prepare(
      `SELECT id, account_id, purchase_date, total_amount_clp, cuotas_totales, merchant
       FROM cc_installment_purchases WHERE total_amount_clp > 0`
    )
    .all() as {
    id: number;
    account_id: number;
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
  }[];
  const principalByPlan = new Map<number, number>();
  for (const accountId of new Set(plans.map((p) => p.account_id))) {
    for (const i of ccInstallmentInterestForAccount(accountId)) principalByPlan.set(i.purchase_id, i.principal_clp);
  }
  for (const p of plans) {
    const iso = normalizeTransactionDateIso(p.purchase_date);
    if (!iso) continue;
    const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId: p.account_id,
      purchaseDateIso: iso,
      cuotasTotales: p.cuotas_totales,
      totalAmountClp: p.total_amount_clp,
      merchant: p.merchant,
    });
    if (!key || linkedKeys.has(`${p.account_id}|${key}`)) continue;
    out.push({
      kind: "plan",
      account_id: p.account_id,
      iso,
      principal_clp: principalByPlan.get(p.id) ?? Math.round(p.total_amount_clp),
      plan_id: p.id,
      purchase_key: key,
    });
  }
  const tagged = db
    .prepare(
      `SELECT l.id, s.account_id, l.transaction_date, l.posting_date, l.amount_clp
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.cuota_purchase_kind IS NOT NULL AND l.amount_clp > 0`
    )
    .all() as { id: number; account_id: number; transaction_date: string | null; posting_date: string | null; amount_clp: number }[];
  for (const t of tagged) {
    const iso = normalizeTransactionDateIso(t.transaction_date ?? t.posting_date);
    if (!iso) continue;
    out.push({ kind: "tagged_line", account_id: t.account_id, iso, principal_clp: Math.round(t.amount_clp), line_id: t.id });
  }
  return out;
}

/** Every subset of `items` whose principals add up to `target`. */
function exactSubsets(items: Payment[], target: number): Payment[][] {
  const out: Payment[][] = [];
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    const pick: Payment[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += items[i]!.principal_clp;
        pick.push(items[i]!);
      }
    }
    if (sum === target) out.push(pick);
  }
  return out;
}

function paymentOnFile(accountId: number, paidOn: string, amount: number): boolean {
  const from = chileCalendarAddDays(paidOn, -3);
  const to = chileCalendarAddDays(paidOn, 5);
  const lines = db
    .prepare(
      `SELECT l.merchant, l.amount_clp, l.transaction_date, l.posting_date
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.amount_clp < 0`
    )
    .all(accountId) as { merchant: string | null; amount_clp: number; transaction_date: string | null; posting_date: string | null }[];
  let paid = 0;
  for (const l of lines) {
    if (!isCcPaymentMerchant(l.merchant)) continue;
    const iso = normalizeTransactionDateIso(l.transaction_date ?? l.posting_date);
    if (iso && iso >= from && iso <= to) paid += -Math.round(l.amount_clp);
  }
  if (paid >= amount) return true;
  const header = db
    .prepare(
      `SELECT 1 AS o FROM cc_statements
       WHERE account_id = ? AND currency = 'clp' AND ABS(ROUND(monto_pagado_anterior)) = ?`
    )
    .get(accountId, amount);
  return header != null;
}

/** What the evidence says, without writing anything. */
export function planFacturadoFinancingLinks(): FacturadoFinancingPlan {
  const links = listCcFacturadoFinancingLinks();
  const linkedMonths = new Set(links.map((l) => `${l.financed_account_id}|${l.financed_billing_month}`));
  const linkedKeys = new Set(links.flatMap((l) => l.financing.map((f) => `${f.account_id}|${f.purchase_key}`)));
  const payments = cuotaPayments(linkedKeys);
  const plan: FacturadoFinancingPlan = { matches: [], ambiguous: [] };
  const candidates: { f: FinancedFacturado; picks: Payment[][] }[] = [];

  for (const f of financedFacturados(linkedMonths)) {
    const last = chileCalendarAddDays(f.pay_by_iso, PAY_BY_GRACE_DAYS);
    const byDay = new Map<string, Payment[]>();
    for (const p of payments) {
      if (p.account_id === f.account_id || p.iso <= f.close_iso || p.iso > last) continue;
      const k = `${p.account_id}|${p.iso}`;
      byDay.set(k, [...(byDay.get(k) ?? []), p]);
    }
    const picks: Payment[][] = [];
    let skipped = false;
    for (const day of byDay.values()) {
      if (day.length > MAX_PURCHASES_PER_DAY) {
        skipped = true;
        continue;
      }
      picks.push(...exactSubsets(day, f.facturado_clp));
    }
    if (picks.length === 0 && !skipped) continue;
    if (picks.length !== 1 || skipped) {
      plan.ambiguous.push({
        financed_account_id: f.account_id,
        financed_billing_month: f.billing_month,
        reason: skipped ? "a day with too many cuota purchases to search" : `${picks.length} combinations of cuota purchases add up to the facturado`,
      });
      continue;
    }
    candidates.push({ f, picks });
  }

  // A purchase that fits two facturados decides neither.
  const uses = new Map<string, number>();
  const idOf = (p: Payment) => (p.kind === "plan" ? `plan|${p.plan_id}` : `line|${p.line_id}`);
  for (const c of candidates) for (const p of c.picks[0]!) uses.set(idOf(p), (uses.get(idOf(p)) ?? 0) + 1);
  for (const { f, picks } of candidates) {
    const pick = picks[0]!;
    if (pick.some((p) => (uses.get(idOf(p)) ?? 0) > 1)) {
      plan.ambiguous.push({
        financed_account_id: f.account_id,
        financed_billing_month: f.billing_month,
        reason: "its cuota purchases also add up to another facturado",
      });
      continue;
    }
    const paidOn = pick.map((p) => p.iso).sort().at(-1)!;
    plan.matches.push({
      financed_account_id: f.account_id,
      financed_billing_month: f.billing_month,
      facturado_clp: f.facturado_clp,
      paid_on: paidOn,
      payments: pick,
      status: pick.every((p) => p.kind === "plan") ? "link" : "pending_plan",
      payment_on_file: paymentOnFile(f.account_id, paidOn, f.facturado_clp),
    });
  }
  return plan;
}

export type FacturadoFinancingApplyResult = FacturadoFinancingPlan & {
  links_created: { financed_account_id: number; financed_billing_month: string }[];
  payments_planted: { financed_account_id: number; paid_on: string; amount_clp: number }[];
};

let running = false;

/**
 * Writes what {@link planFacturadoFinancingLinks} finds. Planting the PAGO is itself a card write,
 * which runs this again from inside the write funnel: the nested call returns at once.
 */
export function applyFacturadoFinancingLinks(): FacturadoFinancingApplyResult | null {
  if (running) return null;
  running = true;
  try {
    const plan = planFacturadoFinancingLinks();
    const result: FacturadoFinancingApplyResult = { ...plan, links_created: [], payments_planted: [] };
    for (const m of plan.matches) {
      if (m.status === "link") {
        upsertCcFacturadoFinancingLink({
          financedAccountId: m.financed_account_id,
          financedBillingMonth: m.financed_billing_month,
          financing: m.payments.map((p) => ({
            account_id: p.account_id,
            purchase_key: (p as Extract<Payment, { kind: "plan" }>).purchase_key,
          })),
        });
        result.links_created.push({ financed_account_id: m.financed_account_id, financed_billing_month: m.financed_billing_month });
      }
      if (!m.payment_on_file) {
        const { cardGroup } = creditCardMasterMetaForAccount(m.financed_account_id);
        const line = webPasteLineFromCardListingLine(cardGroup, {
          date: m.paid_on,
          merchant: "PAGO",
          currency: "clp",
          amount: -m.facturado_clp,
          raw_text: `${ddMmYyyyFromIso(m.paid_on)} PAGO (cuotas en otra tarjeta) ${m.facturado_clp}`,
        });
        importCcWebPasteLines(m.financed_account_id, { lines: [line], errors: [] }, "cc_financing_payment");
        invalidateCcBillingDetail(m.financed_account_id);
        result.payments_planted.push({
          financed_account_id: m.financed_account_id,
          paid_on: m.paid_on,
          amount_clp: m.facturado_clp,
        });
      }
    }
    return result;
  } finally {
    running = false;
  }
}
