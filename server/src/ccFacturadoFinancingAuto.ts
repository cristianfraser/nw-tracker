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
 * A facturado paid in ONE charge on another card (2026-11-09) is matched too, more strictly: a
 * single one-shot peso purchase equal to the facturado to the peso, inside the same window, whose
 * merchant opens like a place the paid card's issuer is paid at (`facturado_paid_at_merchant_prefixes`
 * on `CC_ISSUERS`: a Lider store for the BCI Lider card). One-shots never combine. Such a payment
 * needs no financing link (nothing is spread over cuotas); its line is filed as an internal
 * transfer instead — an «Único» row, only when the line has no category of its own, no per-line
 * override, no declined automatic category and no merchant rule that already keeps it out of gastos
 * (a Lider store's rule is groceries; «RECAUDACION …» is «no cuenta») — so it stays out of gastos, and the PAGO is planted
 * as below. A pending listing that settles under another name is matched again on the next write
 * (the PAGO is then on file; the new line gets its category).
 *
 * The PAGO is planted only when the paid card holds no payment of that amount around the
 * purchase date (lines dated −3…+5 days, or a statement header naming the amount): the statement
 * that later prints the real PAGO settles the planted bucket line like any pasted one.
 */
import { isStatementSourceKind } from "./ccStatementSourceKind.js";

import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import { statementFacturadoClpForBillingMonth } from "./ccFacturadoFinancingProjectionLines.js";
import { listCcFacturadoFinancingLinks, upsertCcFacturadoFinancingLink } from "./ccFacturadoFinancingLinksDb.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import type { CcListingParseResult } from "./ccWebPasteParse.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { ccFacturadoPaidAtMerchantPrefixesForAccount } from "./ccIssuerForAccount.js";
import {
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
  NO_CUENTA_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import { userDeclinedAutoCategoryForPurchase } from "./ccAdditionalCardExpenseMatch.js";
import { getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { requestExpenseLinkSync } from "./expenseLinkSync.js";
import { generalRuleCategoryIdReaching } from "./expenseCategoryRules.js";
import { db } from "./db.js";
import { findLines, planRows } from "./cards/purchases.js";
import { ddMmYyyyFromIso, parseDdMmYyToIso, isCcPaymentMerchant } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";

/** Days past the pay-by a payment still counts toward the facturado (late payments happen). */
const PAY_BY_GRACE_DAYS = MATCH_WINDOWS.financing_pay_by_grace.daysAfter;
/** A day with more cuota purchases than this is not searched (2^n combinations). */
const MAX_PURCHASES_PER_DAY = 10;

type Payment =
  | { kind: "plan"; account_id: number; iso: string; principal_clp: number; plan_id: number; purchase_key: string }
  | { kind: "tagged_line"; account_id: number; iso: string; principal_clp: number; line_id: number }
  | { kind: "one_shot"; account_id: number; iso: string; principal_clp: number; line_id: number; merchant: string };

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
  /**
   * `link`: every payment is a plan; `pending_plan`: a tagged line has no plan yet; `one_shot`: one
   * charge at the full facturado (no link — the line is filed as an internal transfer).
   */
  status: "link" | "pending_plan" | "one_shot";
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
        `SELECT statement_date, period_to, pay_by, source_kind FROM cc_statements
         WHERE account_id = ? AND currency = 'clp' AND monto_facturado > 0`
      )
      .all(accountId) as { statement_date: string; period_to: string | null; pay_by: string | null; source_kind: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!isStatementSourceKind(r.source_kind)) continue;
      const closeIso = parseDdMmYyToIso(r.statement_date);
      const payByIso = r.pay_by ? parseDdMmYyToIso(r.pay_by) : null;
      if (!closeIso || !payByIso) continue;
      const month = billingMonthForCcStatement(r);
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
  const plans = planRows().filter((p) => p.total_amount_clp > 0);
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
  for (const t of findLines({ cuotaPurchaseTagged: true, amountClpSign: "positive" })) {
    const iso = normalizeTransactionDateIso(t.transaction_date ?? t.posting_date);
    if (!iso) continue;
    out.push({ kind: "tagged_line", account_id: t.account_id, iso, principal_clp: Math.round(t.amount_clp!), line_id: t.line_id });
  }
  return out;
}

/**
 * The one-shot peso purchases on card masters whose merchant opens with one of `prefixes`: the
 * candidates for a facturado paid in a single charge.
 */
function oneShotPayments(prefixes: readonly string[], masters: ReadonlySet<number>): Payment[] {
  if (prefixes.length === 0) return [];
  const out: Payment[] = [];
  for (const l of findLines({ amountClpSign: "positive", installmentFlag: 0, merchantPrefixes: prefixes })) {
    if (!masters.has(l.account_id) || l.statement_currency !== "clp") continue;
    if (l.kind !== "card_purchase" || l.cuota_purchase_kind != null) continue;
    const iso = normalizeTransactionDateIso(l.transaction_date ?? l.posting_date);
    if (!iso) continue;
    out.push({
      kind: "one_shot",
      account_id: l.account_id,
      iso,
      principal_clp: Math.round(l.amount_clp!),
      line_id: l.line_id,
      merchant: String(l.merchant ?? ""),
    });
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
  const from = chileCalendarAddDays(paidOn, -MATCH_WINDOWS.financing_payment.daysBefore);
  const to = chileCalendarAddDays(paidOn, MATCH_WINDOWS.financing_payment.daysAfter);
  let paid = 0;
  for (const l of findLines({ accountId, amountClpSign: "negative" })) {
    if (!isCcPaymentMerchant(l.merchant)) continue;
    const iso = normalizeTransactionDateIso(l.transaction_date ?? l.posting_date);
    if (iso && iso >= from && iso <= to) paid += -Math.round(l.amount_clp!);
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
  const masters = new Set(listCreditCardMasterAccountIds());
  const oneShotsByPrefixes = new Map<string, Payment[]>();
  const oneShotsFor = (accountId: number): Payment[] => {
    const prefixes = ccFacturadoPaidAtMerchantPrefixesForAccount(accountId);
    const key = prefixes.join("|");
    let hit = oneShotsByPrefixes.get(key);
    if (!hit) {
      hit = oneShotPayments(prefixes, masters);
      oneShotsByPrefixes.set(key, hit);
    }
    return hit;
  };
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
    // A single charge for the whole facturado, at a place the card is paid at; never combined.
    for (const p of oneShotsFor(f.account_id)) {
      if (p.account_id === f.account_id || p.iso <= f.close_iso || p.iso > last) continue;
      if (p.principal_clp === f.facturado_clp) picks.push([p]);
    }
    if (picks.length === 0 && !skipped) continue;
    if (picks.length !== 1 || skipped) {
      plan.ambiguous.push({
        financed_account_id: f.account_id,
        financed_billing_month: f.billing_month,
        reason: skipped ? "a day with too many cuota purchases to search" : `${picks.length} combinations of purchases add up to the facturado`,
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
        reason: "its purchases also add up to another facturado",
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
      status: pick.every((p) => p.kind === "plan") ? "link" : pick[0]!.kind === "one_shot" ? "one_shot" : "pending_plan",
      payment_on_file: paymentOnFile(f.account_id, paidOn, f.facturado_clp),
    });
  }
  return plan;
}

export type FacturadoFinancingApplyResult = FacturadoFinancingPlan & {
  links_created: { financed_account_id: number; financed_billing_month: string }[];
  payments_planted: { financed_account_id: number; paid_on: string; amount_clp: number }[];
  /** One-shot payment lines filed as internal transfers by this pass. */
  lines_filed_as_transfer: { account_id: number; line_id: number; financed_account_id: number; financed_billing_month: string }[];
};

/**
 * Files a one-shot payment line as an internal transfer, unless the user has said anything about
 * its category (an «Único» row, a per-line override, a declined automatic category) or a merchant
 * rule already keeps it out of gastos («no cuenta» or internal transfer: «RECAUDACION …»). True
 * when written.
 */
function fileOneShotAsInternalTransfer(accountId: number, lineId: number, merchant: string): boolean {
  const lineRow = db.prepare(`SELECT 1 AS o FROM cc_expense_line_categories WHERE statement_line_id = ?`).get(lineId);
  if (lineRow) return false;
  const key = resolveCcExpensePurchaseKey(lineId);
  if (getFlowCategory(accountId, key) !== undefined) return false;
  if (userDeclinedAutoCategoryForPurchase(accountId, key)) return false;
  const cat = getCcExpenseCategoryBySlug(CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG);
  if (!cat) throw new Error(`expense category ${CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG} missing`);
  const ruled = generalRuleCategoryIdReaching(merchant);
  if (ruled != null && (ruled === cat.id || ruled === getCcExpenseCategoryBySlug(NO_CUENTA_CC_EXPENSE_SLUG)?.id)) return false;
  putFlowCategory(accountId, key, cat.id, "keep");
  return true;
}

let running = false;

/**
 * Writes what {@link planFacturadoFinancingLinks} finds. Planting the PAGO is itself a card write,
 * which runs this again from inside the write funnel: the nested call returns at once.
 */
export function applyFacturadoFinancingLinks(
  /** Plants the PAGO on the paid card (the card-line funnel's listing import, `cards/lineWrites.ts`). */
  plant: (accountId: number, parsed: CcListingParseResult) => void
): FacturadoFinancingApplyResult | null {
  if (running) return null;
  running = true;
  try {
    const plan = planFacturadoFinancingLinks();
    const result: FacturadoFinancingApplyResult = {
      ...plan,
      links_created: [],
      payments_planted: [],
      lines_filed_as_transfer: [],
    };
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
      if (m.status === "one_shot") {
        const p = m.payments[0] as Extract<Payment, { kind: "one_shot" }>;
        if (fileOneShotAsInternalTransfer(p.account_id, p.line_id, p.merchant)) {
          result.lines_filed_as_transfer.push({
            account_id: p.account_id,
            line_id: p.line_id,
            financed_account_id: m.financed_account_id,
            financed_billing_month: m.financed_billing_month,
          });
        }
      }
      if (!m.payment_on_file) {
        const line = listingLineFromCardListingLine({
          date: m.paid_on,
          merchant: "PAGO",
          currency: "clp",
          amount: -m.facturado_clp,
          raw_text: `${ddMmYyyyFromIso(m.paid_on)} PAGO (${m.status === "one_shot" ? "pagado con otra tarjeta" : "cuotas en otra tarjeta"}) ${m.facturado_clp}`,
        });
        plant(m.financed_account_id, { lines: [line], errors: [] });
        result.payments_planted.push({
          financed_account_id: m.financed_account_id,
          paid_on: m.paid_on,
          amount_clp: m.facturado_clp,
        });
      }
    }
    if (result.lines_filed_as_transfer.length > 0) requestExpenseLinkSync();
    return result;
  } finally {
    running = false;
  }
}
