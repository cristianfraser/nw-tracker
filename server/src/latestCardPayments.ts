/**
 * «Últimos movimientos»' card payments, once each: every `pago_tarjeta` transfer into a card master
 * — from a bank account (the checking debit absorbed by the mirror converter, a receipt or a manual
 * payment) or from another card (`card_to_card_payments`: a facturado paid with a charge or a cuota
 * plan there). Each carries its evidence lines: the payment line on the card paid (matched by its
 * payment identity, `pagoTarjetaCardLegKey` ↔ `paymentLineIdentityKey`) and, card to card, the
 * paying part (the charge's lines by flow, the plan's whole-price line). Those lines are not rows of
 * their own.
 */
import type { LatestCardPayment, LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";
import { db } from "./db.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import { pagoTarjetaCardLegKey, paymentLineIdentityKey, currentPlasticLast4 } from "./expensePaymentNames.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import { usdToClpReferenceRounded } from "./fxRates.js";
import { lineConvertedForWire } from "./lineMoney.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";

export type CardPaymentTransfer = {
  movement_id: number;
  from_account_id: number;
  from_name: string;
  to_account_id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
  /** Card to card: the paying part. */
  part: { kind: "charge"; flow_id: number } | { kind: "plan"; installment_purchase_id: number } | null;
};

let selTransfersStmt: ReturnType<typeof db.prepare> | null = null;
const selTransfersSql = (
  `SELECT m.id AS movement_id, m.from_account_id, a.name AS from_name, m.to_account_id, m.occurred_on,
          m.amount, m.currency, m.counter_amount, m.counter_currency, c.part_kind, c.part_ref
     FROM movements m
     JOIN accounts a ON a.id = m.from_account_id
     LEFT JOIN card_to_card_payments c ON c.movement_id = m.id
    WHERE m.flow_kind = 'pago_tarjeta' AND m.account_id IS NULL AND m.to_account_id IS NOT NULL`
);
const selTransfers = () => (selTransfersStmt ??= db.prepare(selTransfersSql));

export function loadCardPaymentTransfers(): CardPaymentTransfer[] {
  const masters = new Set(listCreditCardMasterAccountIds());
  const out: CardPaymentTransfer[] = [];
  for (const r of selTransfers().all() as (Omit<CardPaymentTransfer, "part"> & { part_kind: string | null; part_ref: number | null })[]) {
    if (!masters.has(r.to_account_id)) continue;
    const fromCard = masters.has(r.from_account_id);
    if (fromCard && r.part_kind == null) {
      throw new Error(`pago_tarjeta movement ${r.movement_id}: card to card without a card_to_card_payments row`);
    }
    const part =
      r.part_kind === "charge"
        ? { kind: "charge" as const, flow_id: r.part_ref! }
        : r.part_kind === "plan"
          ? { kind: "plan" as const, installment_purchase_id: r.part_ref! }
          : null;
    const { part_kind: _k, part_ref: _r, ...rest } = r;
    out.push({ ...rest, part });
  }
  return out;
}

/** The transfer in its own currency and in each display unit. */
export function cardPaymentMoney(t: CardPaymentTransfer): { amount: Money; values: Record<string, LineUnitValue> } {
  if (t.currency === "clp" && t.counter_currency === "usd" && t.counter_amount != null) {
    // A divisas purchase: the pesos that left, the dollars the card was credited.
    return {
      amount: { value: t.amount, currency: "clp" },
      values: { clp: { value: t.amount, rate_source: "native" }, usd: { value: t.counter_amount, rate_source: "paid" } },
    };
  }
  if (t.counter_currency != null) throw new Error(`pago_tarjeta movement ${t.movement_id}: unexpected counter leg ${t.counter_currency}`);
  if (t.currency === "clp") {
    const usd = clpToUsdAtDate(t.amount, t.occurred_on);
    return {
      amount: { value: t.amount, currency: "clp" },
      values: { clp: { value: t.amount, rate_source: "native" }, ...(usd != null ? { usd: { value: usd, rate_source: "day" as const } } : {}) },
    };
  }
  if (t.currency === "usd") {
    const clpRaw = usdToClpReferenceRounded(t.amount, t.occurred_on);
    const clp = clpRaw == null ? null : Math.round(clpRaw);
    return {
      amount: { value: t.amount, currency: "usd" },
      values: { usd: { value: t.amount, rate_source: "native" }, ...(clp != null ? { clp: { value: clp, rate_source: "day" as const } } : {}) },
    };
  }
  throw new Error(`pago_tarjeta movement ${t.movement_id}: currency ${t.currency}`);
}

function cardLabel(accountId: number): { card_brand: string; card_last4: string } {
  const issuer = ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId));
  const last4 = currentPlasticLast4(accountId);
  if (!issuer || !last4) throw new Error(`card master ${accountId}: no issuer or plastic for its payment label`);
  return { card_brand: issuer.display_brand, card_last4: last4 };
}

type EvidenceLine = Pick<
  FlowCcExpenseLineRow,
  "source" | "account_id" | "amount_clp" | "amount_usd" | "purchase_on" | "posting_on" | "merchant" | "line_role" | "flow_id" | "installment_purchase_id"
>;

/**
 * Each transfer with its evidence line indexes (pure over the loaded facts). A line is evidence of
 * at most one transfer; a payment line two transfers share (same identity) belongs to neither.
 */
export function cardPaymentEvidence<L extends EvidenceLine>(
  transfers: readonly CardPaymentTransfer[],
  lines: readonly L[],
  isPaymentLine: (l: L) => boolean
): Map<number, number[]> {
  const byKey = new Map<string, number[]>();
  for (const t of transfers) {
    const key = pagoTarjetaCardLegKey(t);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), t.movement_id]);
  }
  const evidence = new Map<number, number[]>(transfers.map((t) => [t.movement_id, []]));
  lines.forEach((l, i) => {
    if (l.source !== "cc") return;
    if (isPaymentLine(l)) {
      const key = paymentLineIdentityKey(l as never);
      const owners = key ? byKey.get(key) : undefined;
      if (owners?.length === 1) evidence.get(owners[0]!)!.push(i);
      return;
    }
    for (const t of transfers) {
      if (!t.part || l.account_id !== t.from_account_id) continue;
      const mine =
        t.part.kind === "charge"
          ? l.flow_id === t.part.flow_id && l.line_role !== "installment_cuota"
          : l.installment_purchase_id === t.part.installment_purchase_id && l.line_role === "installment_purchase_total";
      if (mine) evidence.get(t.movement_id)!.push(i);
    }
  });
  return evidence;
}

/**
 * The row, in the requested display unit. A dollar payment's pesos are what its PAGO line on the
 * card shows — the pesos those dollars cost (`usdPaymentLineClpResolver`), not the day's rate —
 * whenever that line is its evidence (`serverLines`: the evidence lines with their money).
 */
export function latestCardPayment(
  t: CardPaymentTransfer,
  lines: LatestCardPayment["lines"],
  unit: string = "clp",
  serverLines: readonly { amount?: Money; values?: Record<string, LineUnitValue> }[] = []
): LatestCardPayment {
  const money = cardPaymentMoney(t);
  const pago = serverLines.find(
    (l) =>
      l.amount != null &&
      l.amount.currency === money.amount.currency &&
      Math.abs(l.amount.value) === Math.abs(money.amount.value) &&
      l.amount.value < 0
  );
  const values = { ...money.values };
  if (pago?.values) {
    for (const [u, v] of Object.entries(pago.values)) {
      if (u !== money.amount.currency && v.rate_source !== "day") values[u] = { value: Math.abs(v.value), rate_source: v.rate_source };
    }
  }
  return {
    key: `movement:${t.movement_id}`,
    movement_id: t.movement_id,
    from: t.part ? { kind: "card", ...cardLabel(t.from_account_id) } : { kind: "account", account_name: t.from_name },
    to: cardLabel(t.to_account_id),
    amount: money.amount,
    converted: lineConvertedForWire({ amount: money.amount, values, occurred_on: t.occurred_on }, unit),
    lines,
  };
}
