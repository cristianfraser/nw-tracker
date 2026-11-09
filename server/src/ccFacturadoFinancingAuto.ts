/**
 * Finds a card's closed facturado paid with purchases on another card, and records it the way the
 * user would by hand: the payment record (`ccFacturadoFinancingLinksDb.ts`: the link row, its
 * plans as financing purchases, its one-shot charges by flow), the payment charges filed as
 * internal transfers and, on the paid card, the PAGO line its daily feed would have shown (BCI has
 * none — its payment otherwise waits for the next statement, counting the debt on both cards).
 *
 * One matcher for every way of paying (2026-11-09). The pool: every peso purchase on another card
 * master — a cuota plan (`cc_installment_purchases`, principal printed by its statement when it
 * carries interest, else its total), a feed line tagged as a cuota purchase whose plan does not
 * exist yet (`cuota_purchase_kind`) and a one-shot purchase — dated after the facturado's close and
 * up to ten days past its pay-by, whose merchant opens like a place the paid card's issuer is paid
 * at (`facturado_paid_at_merchant_prefixes` on `CC_ISSUERS`: a Lider store for the BCI Lider card;
 * an issuer with none is never matched). Each purchase counts once (statement copies of one
 * purchase share its flow). The search: on one paying card and one day, the combinations whose
 * amounts add up to the facturado to the peso. **The fewest payments win** — one charge beats any
 * pair, a pair beats any five; larger combinations never compete. One combination of that size is
 * the payment; several that are interchangeable (same card, day, kinds, merchants and amounts —
 * identical twins) take the one with the lowest ids; any other tie is ambiguous and nothing is
 * written. So is a purchase that fits two facturados, and a day with more than ten candidates.
 *
 * Real cases: ·0101's June 2026 facturado paid as two cuota purchases on 2026-06-30, August's as
 * one on 2026-08-28, July's and every month 2025-09 → 2026-05 in one charge, October's in one
 * charge on 2026-11-09.
 *
 * What a match writes: the payment record, once — a facturado recorded is never matched again,
 * unless every purchase it names is gone (a pending listing that settled under another flow, a
 * charge that settled as a cuota purchase), when the empty record is dropped and the month matched
 * afresh. A match with a tagged line waits for its plan before it is recorded; its PAGO does not
 * wait. Each one-shot charge is filed as an internal transfer — an «Único» row, only when the line
 * has no «Único» row, no per-line override, no declined automatic category and no general rule
 * that already keeps it out of gastos (a Lider store's rule is groceries; «RECAUDACION …» is «no
 * cuenta»). The PAGO is planted only when the paid card holds no payment of that amount around the
 * payment day (lines dated −3…+5 days, or a statement header naming the amount): the statement
 * that later prints the real PAGO settles the planted bucket line like any pasted one.
 *
 * Near misses — a recent facturado with no payment on file and no match, while the paying cards
 * show charges at the issuer's places adding up to half of it or more on one day — are reported
 * (`near_misses`), never written.
 */
import { isStatementSourceKind } from "./ccStatementSourceKind.js";
import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import { statementFacturadoClpForBillingMonth } from "./ccFacturadoFinancingProjectionLines.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  recordCcFacturadoPayment,
} from "./ccFacturadoFinancingLinksDb.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import type { CcListingParseResult } from "./ccWebPasteParse.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
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
import { ddMmYyyyFromIso, foldAccents, parseDdMmYyToIso, isCcPaymentMerchant } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";

/** Days past the pay-by a payment still counts toward the facturado (late payments happen). */
const PAY_BY_GRACE_DAYS = MATCH_WINDOWS.financing_pay_by_grace.daysAfter;
/** A day with more candidate purchases than this is not searched (2^n combinations). */
const MAX_PURCHASES_PER_DAY = 10;
/** How long after its window a facturado still gets near-miss reports (a report's reach, not a match window). */
const NEAR_MISS_RECENT_DAYS = 45; // window-ok

export type FacturadoPayment =
  | { kind: "plan"; account_id: number; iso: string; principal_clp: number; merchant: string; plan_id: number; purchase_key: string }
  | { kind: "tagged_line"; account_id: number; iso: string; principal_clp: number; merchant: string; line_id: number; flow_id: number | null }
  | { kind: "one_shot"; account_id: number; iso: string; principal_clp: number; merchant: string; line_id: number; flow_id: number | null };

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
  payments: FacturadoPayment[];
  /**
   * `complete`: every payment can be recorded (a plan, or a one-shot charge with its flow);
   * `pending_plan`: a tagged line has no plan yet (or a charge no flow) — not recorded until then.
   */
  status: "complete" | "pending_plan";
  /** Whether the paid card already shows the payment. */
  payment_on_file: boolean;
};

export type FacturadoNearMiss = {
  financed_account_id: number;
  financed_billing_month: string;
  facturado_clp: number;
  paying_account_id: number;
  day: string;
  candidates: number;
  total_clp: number;
};

export type FacturadoFinancingPlan = {
  matches: FacturadoFinancingMatch[];
  ambiguous: { financed_account_id: number; financed_billing_month: string; reason: string }[];
  near_misses: FacturadoNearMiss[];
  /** Records whose purchases are all gone: dropped (by the apply) and matched afresh. */
  stale_record_ids: number[];
};

function financedFacturados(recorded: Set<string>): FinancedFacturado[] {
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
      if (!month || seen.has(month) || recorded.has(`${accountId}|${month}`)) continue;
      seen.add(month);
      const facturado = statementFacturadoClpForBillingMonth(accountId, month);
      if (facturado == null || facturado <= 0) continue;
      out.push({ account_id: accountId, billing_month: month, facturado_clp: facturado, close_iso: closeIso, pay_by_iso: payByIso });
    }
  }
  return out;
}

/** Folded, upper-case, single-spaced: how a merchant is compared with the issuer's places. */
function foldMerchant(merchant: string | null | undefined): string {
  return foldAccents(String(merchant ?? "")).toUpperCase().replace(/\s+/g, " ").trim();
}

function opensLikeOneOf(merchant: string, prefixes: readonly string[]): boolean {
  const m = foldMerchant(merchant);
  return prefixes.some((p) => m.startsWith(foldMerchant(p)));
}

/** Every purchase on a card master that could pay another card's facturado, each counted once. */
function paymentPool(recordedPlanKeys: Set<string>): FacturadoPayment[] {
  const masters = new Set(listCreditCardMasterAccountIds());
  const out: FacturadoPayment[] = [];
  const plans = planRows().filter((p) => p.total_amount_clp > 0 && masters.has(p.account_id));
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
    if (!key || recordedPlanKeys.has(`${p.account_id}|${key}`)) continue;
    out.push({
      kind: "plan",
      account_id: p.account_id,
      iso,
      principal_clp: principalByPlan.get(p.id) ?? Math.round(p.total_amount_clp),
      merchant: String(p.merchant ?? ""),
      plan_id: p.id,
      purchase_key: key,
    });
  }
  const seenFlows = new Set<number>();
  for (const l of findLines({ amountClpSign: "positive", clpStatements: true, order: "line" })) {
    if (!masters.has(l.account_id)) continue;
    if (l.cuota_purchase_kind == null && !(l.installment_flag === 0 && l.kind === "card_purchase")) continue;
    // Copies of one purchase (a statement and its listing, two statement copies) share its flow.
    if (l.flow_id != null) {
      if (seenFlows.has(l.flow_id)) continue;
      seenFlows.add(l.flow_id);
    }
    const iso = normalizeTransactionDateIso(l.transaction_date ?? l.posting_date);
    if (!iso) continue;
    out.push({
      kind: l.cuota_purchase_kind != null ? "tagged_line" : "one_shot",
      account_id: l.account_id,
      iso,
      principal_clp: Math.round(l.amount_clp!),
      merchant: String(l.merchant ?? ""),
      line_id: l.line_id,
      flow_id: l.flow_id,
    });
  }
  return out;
}

/** Every subset of `items` whose amounts add up to `target`. */
function exactSubsets(items: FacturadoPayment[], target: number): FacturadoPayment[][] {
  const out: FacturadoPayment[][] = [];
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    const pick: FacturadoPayment[] = [];
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

const idOf = (p: FacturadoPayment) => (p.kind === "plan" ? `plan|${p.plan_id}` : `line|${p.line_id}`);
const sortKey = (p: FacturadoPayment) => (p.kind === "plan" ? p.plan_id : p.line_id);

/** What tells two combinations apart: card, day and each payment's kind, merchant and amount. */
function signature(pick: FacturadoPayment[]): string {
  const parts = pick.map((p) => `${p.kind}|${foldMerchant(p.merchant)}|${p.principal_clp}`).sort();
  return `${pick[0]!.account_id}|${pick[0]!.iso}|${parts.join("+")}`;
}

/** The fewest-payments combination, or why there is none to take. */
function choosePick(picks: FacturadoPayment[][]): { pick: FacturadoPayment[] } | { reason: string } {
  const size = Math.min(...picks.map((p) => p.length));
  const best = picks.filter((p) => p.length === size);
  if (best.length === 1) return { pick: best[0]! };
  const sigs = new Set(best.map(signature));
  if (sigs.size === 1) {
    // Identical twins: any of them will do; the lowest ids, so every pass takes the same one.
    const ordered = best
      .map((p) => [...p].sort((a, b) => sortKey(a) - sortKey(b)))
      .sort((a, b) => {
        for (let i = 0; i < a.length; i++) if (sortKey(a[i]!) !== sortKey(b[i]!)) return sortKey(a[i]!) - sortKey(b[i]!);
        return 0;
      });
    return { pick: ordered[0]! };
  }
  return { reason: `${best.length} combinations of ${size} purchase${size === 1 ? "" : "s"} add up to the facturado` };
}

function paymentOnFile(accountId: number, paidOn: string, amount: number): boolean {
  const from = chileCalendarAddDays(paidOn, -MATCH_WINDOWS.financing_payment.daysBefore);
  const to = chileCalendarAddDays(paidOn, MATCH_WINDOWS.financing_payment.daysAfter);
  return paidBetween(accountId, from, to) >= amount || headerNamesPayment(accountId, amount);
}

function paidBetween(accountId: number, fromIso: string, toIso: string): number {
  let paid = 0;
  for (const l of findLines({ accountId, amountClpSign: "negative" })) {
    if (!isCcPaymentMerchant(l.merchant)) continue;
    const iso = normalizeTransactionDateIso(l.transaction_date ?? l.posting_date);
    if (iso && iso >= fromIso && iso <= toIso) paid += -Math.round(l.amount_clp!);
  }
  return paid;
}

function headerNamesPayment(accountId: number, amount: number): boolean {
  const header = db
    .prepare(
      `SELECT 1 AS o FROM cc_statements
       WHERE account_id = ? AND currency = 'clp' AND ABS(ROUND(monto_pagado_anterior)) = ?`
    )
    .get(accountId, amount);
  return header != null;
}

/** A recorded charge's flow still holds the one-shot purchase it recorded. */
function chargeIsLive(flowId: number): boolean {
  return findLines({ flowId, amountClpSign: "positive", installmentFlag: 0 }).some(
    (l) => l.kind === "card_purchase" && l.cuota_purchase_kind == null
  );
}

/** What the evidence says, without writing anything. */
export function planFacturadoFinancingLinks(): FacturadoFinancingPlan {
  const records = listCcFacturadoFinancingLinks();
  const stale = records.filter(
    (r) => r.financing.length === 0 && (r.charges ?? []).every((c) => !chargeIsLive(c.flow_id))
  );
  const staleIds = new Set(stale.map((r) => r.id));
  const live = records.filter((r) => !staleIds.has(r.id));
  const recordedMonths = new Set(live.map((l) => `${l.financed_account_id}|${l.financed_billing_month}`));
  const recordedPlanKeys = new Set(live.flatMap((l) => l.financing.map((f) => `${f.account_id}|${f.purchase_key}`)));
  const recordedFlows = new Set(live.flatMap((l) => (l.charges ?? []).map((c) => c.flow_id)));
  const pool = paymentPool(recordedPlanKeys).filter(
    (p) => p.kind === "plan" || p.flow_id == null || !recordedFlows.has(p.flow_id)
  );
  const plan: FacturadoFinancingPlan = { matches: [], ambiguous: [], near_misses: [], stale_record_ids: stale.map((r) => r.id) };
  const candidates: { f: FinancedFacturado; pick: FacturadoPayment[] }[] = [];
  const today = chileCalendarTodayYmd();

  for (const f of financedFacturados(recordedMonths)) {
    const prefixes = ccFacturadoPaidAtMerchantPrefixesForAccount(f.account_id);
    if (prefixes.length === 0) continue;
    const last = chileCalendarAddDays(f.pay_by_iso, PAY_BY_GRACE_DAYS);
    const byDay = new Map<string, FacturadoPayment[]>();
    for (const p of pool) {
      if (p.account_id === f.account_id || p.iso <= f.close_iso || p.iso > last) continue;
      if (!opensLikeOneOf(p.merchant, prefixes)) continue;
      const k = `${p.account_id}|${p.iso}`;
      byDay.set(k, [...(byDay.get(k) ?? []), p]);
    }
    const picks: FacturadoPayment[][] = [];
    let skipped = false;
    for (const day of byDay.values()) {
      if (day.length > MAX_PURCHASES_PER_DAY) {
        skipped = true;
        continue;
      }
      picks.push(...exactSubsets(day, f.facturado_clp));
    }
    if (skipped) {
      plan.ambiguous.push({
        financed_account_id: f.account_id,
        financed_billing_month: f.billing_month,
        reason: "a day with too many candidate purchases to search",
      });
      continue;
    }
    if (picks.length === 0) {
      const recent = chileCalendarAddDays(last, NEAR_MISS_RECENT_DAYS) >= today;
      if (recent && paidBetween(f.account_id, chileCalendarAddDays(f.close_iso, 1), last) < f.facturado_clp) {
        for (const [k, day] of byDay) {
          const total = day.reduce((s, p) => s + p.principal_clp, 0);
          if (total * 2 < f.facturado_clp) continue;
          plan.near_misses.push({
            financed_account_id: f.account_id,
            financed_billing_month: f.billing_month,
            facturado_clp: f.facturado_clp,
            paying_account_id: day[0]!.account_id,
            day: k.split("|")[1]!,
            candidates: day.length,
            total_clp: total,
          });
        }
      }
      continue;
    }
    const chosen = choosePick(picks);
    if ("reason" in chosen) {
      plan.ambiguous.push({ financed_account_id: f.account_id, financed_billing_month: f.billing_month, reason: chosen.reason });
      continue;
    }
    candidates.push({ f, pick: chosen.pick });
  }

  // A purchase that fits two facturados decides neither.
  const uses = new Map<string, number>();
  for (const c of candidates) for (const p of c.pick) uses.set(idOf(p), (uses.get(idOf(p)) ?? 0) + 1);
  for (const { f, pick } of candidates) {
    if (pick.some((p) => (uses.get(idOf(p)) ?? 0) > 1)) {
      plan.ambiguous.push({
        financed_account_id: f.account_id,
        financed_billing_month: f.billing_month,
        reason: "its purchases also add up to another facturado",
      });
      continue;
    }
    const paidOn = pick.map((p) => p.iso).sort().at(-1)!;
    const recordable = pick.every((p) => p.kind === "plan" || (p.kind === "one_shot" && p.flow_id != null));
    plan.matches.push({
      financed_account_id: f.account_id,
      financed_billing_month: f.billing_month,
      facturado_clp: f.facturado_clp,
      paid_on: paidOn,
      payments: pick,
      status: recordable ? "complete" : "pending_plan",
      payment_on_file: paymentOnFile(f.account_id, paidOn, f.facturado_clp),
    });
  }
  return plan;
}

export type FacturadoFinancingApplyResult = FacturadoFinancingPlan & {
  /** Facturados whose payment was recorded by this pass. */
  links_created: { financed_account_id: number; financed_billing_month: string }[];
  payments_planted: { financed_account_id: number; paid_on: string; amount_clp: number }[];
  /** One-shot payment lines filed as internal transfers by this pass. */
  lines_filed_as_transfer: { account_id: number; line_id: number; financed_account_id: number; financed_billing_month: string }[];
};

/**
 * Files a one-shot payment line as an internal transfer, unless the user has said anything about
 * its category (an «Único» row, a per-line override, a declined automatic category) or a general
 * rule already keeps it out of gastos («no cuenta» or internal transfer). True when written.
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
    for (const id of plan.stale_record_ids) deleteCcFacturadoFinancingLink(id);
    const result: FacturadoFinancingApplyResult = {
      ...plan,
      links_created: [],
      payments_planted: [],
      lines_filed_as_transfer: [],
    };
    for (const m of plan.matches) {
      if (m.status === "complete") {
        recordCcFacturadoPayment({
          financedAccountId: m.financed_account_id,
          financedBillingMonth: m.financed_billing_month,
          plans: m.payments.flatMap((p) => (p.kind === "plan" ? [{ account_id: p.account_id, purchase_key: p.purchase_key }] : [])),
          charges: m.payments.flatMap((p) =>
            p.kind === "one_shot" ? [{ account_id: p.account_id, flow_id: p.flow_id!, amount_clp: p.principal_clp }] : []
          ),
        });
        result.links_created.push({ financed_account_id: m.financed_account_id, financed_billing_month: m.financed_billing_month });
      }
      for (const p of m.payments) {
        if (p.kind !== "one_shot") continue;
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
        const allCuotas = m.payments.every((p) => p.kind !== "one_shot");
        const line = listingLineFromCardListingLine({
          date: m.paid_on,
          merchant: "PAGO",
          currency: "clp",
          amount: -m.facturado_clp,
          raw_text: `${ddMmYyyyFromIso(m.paid_on)} PAGO (${allCuotas ? "cuotas en otra tarjeta" : "pagado con otra tarjeta"}) ${m.facturado_clp}`,
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
