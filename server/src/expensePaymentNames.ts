/**
 * Names a card payment expense line by what it paid (`FlowCcExpenseLineRow.payment_name`), from the
 * stored payment records — never from the bank's text, and display only: `merchant`, categories,
 * keys and dedupe are untouched.
 *
 * - `pays_card`: a one-shot charge recorded as paying another card's facturado
 *   (`cc_facturado_payment_charges`, by flow) or a cuota plan linked to one (`finances_facturado`
 *   flow links; the plan's «Total» line and its cuota lines carry the plan's purchase key). Names the
 *   PAID card.
 * - `paid_by_card`: on the paid card, the payment line of exactly the facturado (or, for a facturado
 *   paid in parts, one payment line per part — each charge or plan — adding up to it), dated inside the
 *   window the facturado matcher uses to decide a PAGO is already on file
 *   (`MATCH_WINDOWS.financing_payment`, around the day the charges or plans paid it). Matched by
 *   facts (card, amount, day), so the statement's PAGO that settles a planted one keeps the name.
 *   One-to-one: a link with several payments in its window, or a payment two links reach, gets none.
 * - `paid_from_account`: a card payment line that is the card leg of a `pago_tarjeta` transfer from a
 *   bank account, by the payment identity of `ccPaymentMirrorEvidence.ts` (card, currency, day,
 *   pesos — dollars for a dollar payment). Two transfers with one identity name nothing.
 */
import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant, parseDdMmYyToIso } from "nw-tracker-contracts";
import type { ExpenseLinePaymentName } from "nw-tracker-contracts/dto/flows";
import { listCcFacturadoFinancingLinks } from "./ccFacturadoFinancingLinksDb.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import { isStatementSourceKind } from "./ccStatementSourceKind.js";
import { ccPaymentEvidenceKey, type CcPaymentIdentity } from "./ccPaymentMirrorEvidence.js";
import { findLines } from "./cards/purchases.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

/** The fields of an expense line the names read. */
export type PaymentNameLine = {
  source: string;
  account_id: number;
  statement_line_id: number;
  purchase_key: string;
  line_role: string;
  merchant: string | null;
  amount_clp: number;
  amount_usd: number | null;
  purchase_on: string | null;
  posting_on?: string | null;
  primary_card_last4: string | null;
  payment_name?: ExpenseLinePaymentName;
};

export type PaymentNameCard = { brand: string; last4: string };

/** One recorded facturado payment. */
export type FacturadoPaymentFact = {
  paid_account_id: number;
  /** The facturado paid; null when the closed statement is not on file (no `paid_by_card`). */
  facturado_clp: number | null;
  /** The financing plans, by card and purchase key. */
  plans: { account_id: number; purchase_key: string }[];
  /** The one-shot charges, by card and the ids of the statement lines that carry them. */
  charges: { account_id: number; line_ids: number[] }[];
};

/** A `pago_tarjeta` transfer into a card from a bank account, by its card-leg payment identity. */
export type CardPaymentTransferFact = { key: string; from_account_name: string };

export type PaymentNameFacts = {
  payments: FacturadoPaymentFact[];
  transfers: CardPaymentTransferFact[];
  cards: ReadonlyMap<number, PaymentNameCard>;
  window: { daysBefore: number; daysAfter: number };
};

const lineDay = (l: PaymentNameLine): string | null => l.purchase_on ?? l.posting_on ?? null;

export const isPaymentLine = (l: PaymentNameLine): boolean =>
  l.source === "cc" && (l.amount_clp < 0 || (l.amount_usd != null && l.amount_usd < 0)) && (isCcPaymentMerchant(l.merchant) || isCcUsdDebtAbonoMerchant(l.merchant));

/** The payment identity of a card payment line (dollars for a line on a dollar statement). */
export function paymentLineIdentityKey(l: PaymentNameLine): string | null {
  const day = lineDay(l);
  if (!day) return null;
  const identity: CcPaymentIdentity =
    l.amount_usd != null
      ? { cc_account_id: l.account_id, pago_iso: day, currency: "usd", amount_clp: 0, amount_foreign: Math.abs(l.amount_usd) }
      : { cc_account_id: l.account_id, pago_iso: day, currency: "clp", amount_clp: Math.abs(l.amount_clp), amount_foreign: null };
  return ccPaymentEvidenceKey(identity);
}

/** The lines named, in input order (pure). */
export function nameExpensePaymentLines<L extends PaymentNameLine>(lines: readonly L[], facts: PaymentNameFacts): L[] {
  const names = new Map<number, ExpenseLinePaymentName>();
  // A card is named by the plastic it is known by today (`facts.cards`), whatever a line carries:
  // plan and pasted lines carry the master's identity (·0901), not the plastic (·0781).
  const card = (accountId: number, _line?: PaymentNameLine): PaymentNameCard | null => facts.cards.get(accountId) ?? null;

  // pays_card, and each record's paying card and day.
  const ccLineIdx = new Map<number, number[]>();
  const keyIdx = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.source !== "cc") return;
    if (l.statement_line_id > 0) ccLineIdx.set(l.statement_line_id, [...(ccLineIdx.get(l.statement_line_id) ?? []), i]);
    const k = `${l.account_id}|${l.purchase_key}`;
    keyIdx.set(k, [...(keyIdx.get(k) ?? []), i]);
  });
  type Anchor = {
    paid_account_id: number;
    facturado_clp: number;
    /** Each charge's and plan's whole pesos: a facturado paid in parts may print one PAGO per part. */
    part_clp: number[];
    paying_account_id: number;
    day: string;
    paying_line: PaymentNameLine;
  };
  const anchors: Anchor[] = [];
  for (const p of facts.payments) {
    const paid = card(p.paid_account_id);
    if (!paid) continue;
    const paying: { idx: number; account_id: number }[] = [];
    for (const c of p.charges) for (const id of c.line_ids) for (const i of ccLineIdx.get(id) ?? []) paying.push({ idx: i, account_id: c.account_id });
    for (const pl of p.plans) for (const i of keyIdx.get(`${pl.account_id}|${pl.purchase_key}`) ?? []) paying.push({ idx: i, account_id: pl.account_id });
    for (const { idx } of paying) {
      names.set(idx, { kind: "pays_card", card_brand: paid.brand, card_last4: paid.last4 });
    }
    const accounts = new Set(paying.map((x) => x.account_id));
    if (p.facturado_clp == null || accounts.size !== 1) continue;
    // The day the facturado was paid: the latest day of its charges and plans (a plan by its purchase day).
    // A plan's cuota lines are a fallback only: its «Total» line carries the purchase day.
    let best: { day: string; line: PaymentNameLine } | null = null;
    for (const cuotas of [false, true]) {
      for (const { idx } of paying) {
        const l = lines[idx]!;
        if ((l.line_role === "installment_cuota") !== cuotas) continue;
        const d = lineDay(l);
        if (d && (!best || d > best.day)) best = { day: d, line: l };
      }
      if (best) break;
    }
    if (!best) continue;
    const part_clp: number[] = [];
    for (const c of p.charges) {
      const i = c.line_ids.flatMap((id) => ccLineIdx.get(id) ?? [])[0];
      if (i != null) part_clp.push(Math.round(lines[i]!.amount_clp));
    }
    for (const pl of p.plans) {
      const i = (keyIdx.get(`${pl.account_id}|${pl.purchase_key}`) ?? []).find(
        (j) => lines[j]!.line_role === "installment_purchase_total"
      );
      if (i != null) part_clp.push(Math.round(lines[i]!.amount_clp));
    }
    anchors.push({
      paid_account_id: p.paid_account_id,
      facturado_clp: p.facturado_clp,
      part_clp,
      paying_account_id: [...accounts][0]!,
      day: best.day,
      paying_line: best.line,
    });
  }

  // paid_by_card: the payment of the whole facturado, else one payment per part (a charge or plan)
  // adding up to it; each payment identity claimed by one record only.
  const paymentIdx = lines.map((l, i) => (isPaymentLine(l) && l.amount_usd == null ? i : -1)).filter((i) => i >= 0);
  const claims = new Map<string, number[]>();
  const claimsByAnchor: string[][] = anchors.map((a, ai) => {
    const from = chileCalendarAddDays(a.day, -facts.window.daysBefore);
    const to = chileCalendarAddDays(a.day, facts.window.daysAfter);
    const keysByPesos = new Map<number, Set<string>>();
    for (const i of paymentIdx) {
      const l = lines[i]!;
      const d = lineDay(l);
      if (l.account_id !== a.paid_account_id || !d || d < from || d > to) continue;
      const pesos = Math.round(-l.amount_clp);
      if (!keysByPesos.has(pesos)) keysByPesos.set(pesos, new Set());
      keysByPesos.get(pesos)!.add(paymentLineIdentityKey(l)!);
    }
    let keys: string[] = [];
    const whole = keysByPesos.get(a.facturado_clp);
    if (whole && whole.size === 1) keys = [...whole];
    else if (!whole && a.part_clp.length > 1 && a.part_clp.reduce((x, y) => x + y, 0) === a.facturado_clp) {
      // Parts of distinct pesos, each paid by exactly one payment.
      if (new Set(a.part_clp).size === a.part_clp.length) {
        const parts = a.part_clp.map((pesos) => keysByPesos.get(pesos));
        if (parts.every((k) => k?.size === 1)) keys = parts.map((k) => [...k!][0]!);
      }
    }
    for (const key of keys) claims.set(key, [...(claims.get(key) ?? []), ai]);
    return keys;
  });
  claimsByAnchor.forEach((keys, ai) => {
    if (keys.length === 0 || keys.some((k) => claims.get(k)!.length !== 1)) return;
    const a = anchors[ai]!;
    const payer = card(a.paying_account_id, a.paying_line);
    if (!payer) return;
    const mine = new Set(keys);
    for (const i of paymentIdx) {
      if (names.has(i) || !mine.has(paymentLineIdentityKey(lines[i]!)!)) continue;
      names.set(i, { kind: "paid_by_card", card_brand: payer.brand, card_last4: payer.last4 });
    }
  });

  // paid_from_account.
  const transferByKey = new Map<string, string | null>();
  for (const t of facts.transfers) transferByKey.set(t.key, transferByKey.has(t.key) ? null : t.from_account_name);
  lines.forEach((l, i) => {
    if (names.has(i) || !isPaymentLine(l)) return;
    const key = paymentLineIdentityKey(l);
    const from = key ? transferByKey.get(key) : undefined;
    if (from) names.set(i, { kind: "paid_from_account", account_name: from });
  });

  if (names.size === 0) return [...lines];
  return lines.map((l, i) => {
    const n = names.get(i);
    return n ? { ...l, payment_name: n } : l;
  });
}

const selPagoTarjetaTransfers = db.prepare(
  `SELECT m.to_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, a.name AS from_name, m.from_account_id
     FROM movements m JOIN accounts a ON a.id = m.from_account_id
    WHERE m.flow_kind = 'pago_tarjeta' AND m.account_id IS NULL AND m.to_account_id IS NOT NULL`
);
const selCardLast4 = db.prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`);
/** A card's statements' titular plastics, with each statement's source kind (bank listings carry the config's). */
const selStatementPlastics = db.prepare(
  `SELECT card_last4, statement_date, source_kind FROM cc_statements
    WHERE account_id = ? AND card_last4 IS NOT NULL AND card_last4 <> ''`
);

/**
 * The plastic a card is known by today: its newest issued statement's titular card (·0781 for a
 * master whose identity is the replaced ·0901), else the config's card identity.
 */
export function currentPlasticLast4(accountId: number): string | null {
  let best: { iso: string; last4: string } | null = null;
  for (const r of selStatementPlastics.all(accountId) as { card_last4: string; statement_date: string; source_kind: string }[]) {
    if (!isStatementSourceKind(r.source_kind)) continue;
    const iso = parseDdMmYyToIso(r.statement_date);
    if (iso && (!best || iso > best.iso)) best = { iso, last4: r.card_last4 };
  }
  if (best) return best.last4;
  return (selCardLast4.get(accountId) as { card_last4: string | null } | undefined)?.card_last4 ?? null;
}

/**
 * A facturado's closed statement total (`statementFacturadoClpForBillingMonth`, passed in by the
 * pipeline: that module reads the expense-line types, so importing it here would close a cycle).
 */
export type FacturadoClpResolver = (accountId: number, billingMonth: string) => number | null;

/** The stored records the names read, loaded once per build. */
export function loadPaymentNameFacts(facturadoFor: FacturadoClpResolver): PaymentNameFacts {
  const masters = listCreditCardMasterAccountIds();
  const masterSet = new Set(masters);
  const cards = new Map<number, PaymentNameCard>();
  for (const id of masters) {
    const brand = ccIssuerBySlug(ccIssuerSlugForMasterAccount(id))!.display_brand;
    const last4 = currentPlasticLast4(id);
    if (last4) cards.set(id, { brand, last4 });
  }
  const payments: FacturadoPaymentFact[] = listCcFacturadoFinancingLinks().map((link) => ({
    paid_account_id: link.financed_account_id,
    facturado_clp: facturadoFor(link.financed_account_id, link.financed_billing_month),
    plans: link.financing,
    charges: (link.charges ?? []).map((c) => ({
      account_id: c.account_id,
      line_ids: findLines({ flowId: c.flow_id }).map((l) => l.line_id),
    })),
  }));
  const transfers: CardPaymentTransferFact[] = [];
  for (const r of selPagoTarjetaTransfers.all() as {
    to_account_id: number;
    occurred_on: string;
    amount: number;
    currency: string;
    counter_amount: number | null;
    counter_currency: string | null;
    from_name: string;
    from_account_id: number;
  }[]) {
    if (!masterSet.has(r.to_account_id) || masterSet.has(r.from_account_id)) continue;
    const key = pagoTarjetaCardLegKey(r);
    if (key == null) continue;
    transfers.push({ key, from_account_name: r.from_name });
  }
  return { payments, transfers, cards, window: MATCH_WINDOWS.financing_payment };
}

/**
 * A `pago_tarjeta` transfer's card leg as a payment identity (`ccPaymentEvidenceKey`): pesos for a
 * peso transfer, the dollars credited for a divisas purchase (counter leg) or a transfer from a
 * dollar account; null for any other shape.
 */
export function pagoTarjetaCardLegKey(r: {
  to_account_id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
}): string | null {
  let identity: CcPaymentIdentity;
  if (r.counter_currency != null && r.counter_currency !== "clp" && r.counter_amount != null) {
    identity = { cc_account_id: r.to_account_id, pago_iso: r.occurred_on, currency: r.counter_currency, amount_clp: Math.round(r.amount), amount_foreign: r.counter_amount };
  } else if (r.counter_currency == null && r.currency !== "clp") {
    identity = { cc_account_id: r.to_account_id, pago_iso: r.occurred_on, currency: r.currency, amount_clp: 0, amount_foreign: r.amount };
  } else if (r.counter_currency == null && r.currency === "clp") {
    identity = { cc_account_id: r.to_account_id, pago_iso: r.occurred_on, currency: "clp", amount_clp: Math.round(r.amount), amount_foreign: null };
  } else return null;
  return ccPaymentEvidenceKey(identity);
}

/** The pipeline step: card payment lines named by what they paid. */
export function withExpensePaymentNames<L extends PaymentNameLine>(lines: L[], facturadoFor: FacturadoClpResolver): L[] {
  if (!lines.some((l) => l.source === "cc")) return lines;
  return nameExpensePaymentLines(lines, loadPaymentNameFacts(facturadoFor));
}
