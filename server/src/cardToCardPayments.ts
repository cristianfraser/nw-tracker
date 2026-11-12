/**
 * A card's facturado paid with purchases on another card, recorded once as money: one
 * `pago_tarjeta` transfer per part of its payment record (`ccFacturadoFinancingLinksDb.ts`, made
 * by the matcher in `ccFacturadoFinancingAuto.ts` or by hand), paying card master → paid card
 * master. A part is a one-shot charge (`cc_facturado_payment_charges`, by flow: its line's pesos on
 * its day) or a plan (`finances_facturado` flow links: its principal — the printed one for an
 * interest plan, else its total, the figure the matcher sums — on its purchase day). Pesos only: a
 * dollar part throws (a dollar card→card transfer is not a payment `foreignDebtPaymentsForAccount`
 * can price).
 *
 * Derived state, rebuilt by {@link syncCardToCardPaymentTransfers}: a missing transfer is written,
 * one whose ends, pesos or day changed is replaced (deleted and written again — a movement's flow
 * is not rewritten on update), one whose record or part is gone is deleted. Each transfer's row in
 * `card_to_card_payments` names its part (migration 311); deleting a record cascades its rows and
 * their trigger deletes the transfers.
 *
 * What the transfer does to the readers, all by the existing `pago_tarjeta` rules: no deposit
 * event on either card (`accountDeposits.ts` skips card legs), not cash paid to a card in the flows
 * overview (only transfers out of a checking account are, `flowsOverviewCash.ts`), inert for the
 * cards' owed walks and derived flows (card balances never read movements), one internal «Pago
 * tarjeta» row on a page holding both cards. The paid card's PAGO it explains is not offered to the
 * checking payment mirror (`ccPaymentMirrors.ts`), so a same-pesos checking debit cannot pair with it.
 */
import { isHomeCurrency } from "./displayUnits.js";
import { db } from "./db.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";
import { listCcFacturadoFinancingLinks } from "./ccFacturadoFinancingLinksDb.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { findLines, planRows, type CardPlanRow } from "./cards/purchases.js";

/** The note prefix of these transfers (human provenance; nothing reads it). */
export const CARD_TO_CARD_NOTE_PREFIX = "card-to-card:";

export type CardToCardPart = {
  financing_link_id: number;
  financed_billing_month: string;
  part_kind: "charge" | "plan";
  /** The charge's flow id, or the plan's `cc_installment_purchases.id`. */
  part_ref: number;
  from_account_id: number;
  to_account_id: number;
  amount_clp: number;
  occurred_on: string;
};

export type CardToCardSyncResult = {
  created: (CardToCardPart & { movement_id: number })[];
  updated: { before: CardToCardPart & { movement_id: number }; after: CardToCardPart & { movement_id: number } }[];
  deleted: (CardToCardPart & { movement_id: number })[];
  unchanged: number;
};

function partKey(p: { financing_link_id: number; part_kind: string; part_ref: number }): string {
  return `${p.financing_link_id}|${p.part_kind}|${p.part_ref}`;
}

/** Every part every facturado payment record states, as the transfer it should be. */
export function expectedCardToCardParts(): CardToCardPart[] {
  const masters = new Set(listCreditCardMasterAccountIds());
  const links = new Map(
    (
      db.prepare(`SELECT id, financed_account_id, financed_billing_month FROM cc_facturado_financing_links`).all() as {
        id: number;
        financed_account_id: number;
        financed_billing_month: string;
      }[]
    ).map((l) => [l.id, l])
  );
  const out: CardToCardPart[] = [];

  const charges = db
    .prepare(`SELECT financing_link_id, flow_id, account_id FROM cc_facturado_payment_charges ORDER BY rowid`)
    .all() as { financing_link_id: number; flow_id: number; account_id: number }[];
  for (const c of charges) {
    const link = links.get(c.financing_link_id)!;
    // A statement's line before a listing's copy, then by id.
    const lines = findLines({ flowId: c.flow_id, accountId: c.account_id, order: "line" }).sort(
      (a, b) => Number(a.source_kind === "listing_open") - Number(b.source_kind === "listing_open") || a.line_id - b.line_id
    );
    // The charge settled under another flow, or its line is gone: no part (the matcher drops the record).
    if (lines.length === 0) continue;
    const line = lines.find((l) => isHomeCurrency(l.statement_currency));
    if (!line) {
      throw new Error(
        `facturado payment ${c.financing_link_id}: charge flow ${c.flow_id} is a dollar charge — a card-to-card payment is pesos only`
      );
    }
    const iso = normalizeTransactionDateIso(line.transaction_date ?? line.posting_date);
    if (!iso) throw new Error(`facturado payment ${c.financing_link_id}: charge line ${line.line_id} has no readable date`);
    out.push({
      financing_link_id: c.financing_link_id,
      financed_billing_month: link.financed_billing_month,
      part_kind: "charge",
      part_ref: c.flow_id,
      from_account_id: c.account_id,
      to_account_id: link.financed_account_id,
      amount_clp: Math.round(Number(line.amount_clp)),
      occurred_on: iso,
    });
  }

  // A record names its plans by purchase key (the key the matcher records and the projection
  // reads); identical twin plans share it, and the record pays them all.
  const linkPlans = listCcFacturadoFinancingLinks().flatMap((l) =>
    l.financing.map((f) => ({ financing_link_id: l.id, account_id: f.account_id, purchase_key: f.purchase_key }))
  );
  const accountsWithPlans = [...new Set(linkPlans.map((f) => f.account_id))];
  const plansByKey = new Map<string, CardPlanRow[]>();
  for (const p of planRows(accountsWithPlans)) {
    const iso = normalizeTransactionDateIso(p.purchase_date);
    if (!iso) continue;
    const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId: p.account_id,
      purchaseDateIso: iso,
      cuotasTotales: p.cuotas_totales,
      totalAmountClp: p.total_amount_clp,
      merchant: p.merchant,
    });
    if (!key) continue;
    const k = `${p.account_id}|${key}`;
    plansByKey.set(k, [...(plansByKey.get(k) ?? []), p]);
  }
  const principalByAccount = new Map<number, Map<number, number>>();
  const principalOf = (accountId: number, planId: number): number | undefined => {
    let m = principalByAccount.get(accountId);
    if (!m) {
      m = new Map(ccInstallmentInterestForAccount(accountId).map((i) => [i.purchase_id, i.principal_clp]));
      principalByAccount.set(accountId, m);
    }
    return m.get(planId);
  };
  const seenPlans = new Set<string>();
  for (const f of linkPlans) {
    const link = links.get(f.financing_link_id)!;
    // A plan gone (a statement replaced it under another key, a deletion): no part.
    for (const p of plansByKey.get(`${f.account_id}|${f.purchase_key}`) ?? []) {
      if (seenPlans.has(`${f.financing_link_id}|${p.id}`)) continue;
      seenPlans.add(`${f.financing_link_id}|${p.id}`);
      out.push({
        financing_link_id: f.financing_link_id,
        financed_billing_month: link.financed_billing_month,
        part_kind: "plan",
        part_ref: p.id,
        from_account_id: p.account_id,
        to_account_id: link.financed_account_id,
        amount_clp: Math.round(principalOf(p.account_id, p.id) ?? p.total_amount_clp),
        occurred_on: normalizeTransactionDateIso(p.purchase_date)!,
      });
    }
  }

  for (const p of out) {
    const where = `facturado payment ${p.financing_link_id} (${p.part_kind} ${p.part_ref})`;
    if (!masters.has(p.from_account_id)) throw new Error(`${where}: paying account ${p.from_account_id} is not a card master`);
    if (!masters.has(p.to_account_id)) throw new Error(`${where}: paid account ${p.to_account_id} is not a card master`);
    if (p.from_account_id === p.to_account_id) throw new Error(`${where}: a card cannot pay its own facturado`);
    if (!(Number.isInteger(p.amount_clp) && p.amount_clp > 0)) throw new Error(`${where}: amount ${p.amount_clp} is not positive pesos`);
  }
  return out;
}

const selStored = db.prepare(
  `SELECT c.movement_id, c.financing_link_id, c.part_kind, c.part_ref,
          m.account_id, m.from_account_id, m.to_account_id, m.amount, m.currency, m.counter_amount, m.occurred_on, m.flow_kind,
          COALESCE(l.financed_billing_month, '') AS financed_billing_month
     FROM card_to_card_payments c
     JOIN movements m ON m.id = c.movement_id
     LEFT JOIN cc_facturado_financing_links l ON l.id = c.financing_link_id
    ORDER BY c.movement_id`
);
const insMovement = db.prepare(
  `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
   VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?)`
);
const insRow = db.prepare(
  `INSERT INTO card_to_card_payments (movement_id, financing_link_id, part_kind, part_ref) VALUES (?, ?, ?, ?)`
);
const delMovement = db.prepare(`DELETE FROM movements WHERE id = ?`);

function noteFor(p: CardToCardPart): string {
  return (
    `${CARD_TO_CARD_NOTE_PREFIX} facturado ${p.financed_billing_month} of account ${p.to_account_id} ` +
    `paid by account ${p.from_account_id} (${p.part_kind === "charge" ? "one-shot charge" : "cuota plan"} ${p.part_ref})`
  );
}

/**
 * Brings the card-to-card transfers in line with the payment records. Idempotent; one transaction
 * (a savepoint inside an open one).
 */
export function syncCardToCardPaymentTransfers(): CardToCardSyncResult {
  return db.transaction((): CardToCardSyncResult => {
    const expected = new Map(expectedCardToCardParts().map((p) => [partKey(p), p]));
    const result: CardToCardSyncResult = { created: [], updated: [], deleted: [], unchanged: 0 };
    const write = (p: CardToCardPart): number => {
      const r = insMovement.run(p.from_account_id, p.to_account_id, p.amount_clp, p.occurred_on, noteFor(p), FLOW_KIND_PAGO_TARJETA);
      const id = Number(r.lastInsertRowid);
      insRow.run(id, p.financing_link_id, p.part_kind, p.part_ref);
      return id;
    };
    for (const s of selStored.all() as {
      movement_id: number;
      financing_link_id: number;
      part_kind: "charge" | "plan";
      part_ref: number;
      account_id: number | null;
      from_account_id: number;
      to_account_id: number;
      amount: number;
      currency: string;
      counter_amount: number | null;
      occurred_on: string;
      flow_kind: string | null;
      financed_billing_month: string;
    }[]) {
      const before = {
        movement_id: s.movement_id,
        financing_link_id: s.financing_link_id,
        financed_billing_month: s.financed_billing_month,
        part_kind: s.part_kind,
        part_ref: s.part_ref,
        from_account_id: s.from_account_id,
        to_account_id: s.to_account_id,
        amount_clp: s.amount,
        occurred_on: s.occurred_on,
      };
      const want = expected.get(partKey(s));
      expected.delete(partKey(s));
      if (!want) {
        delMovement.run(s.movement_id);
        result.deleted.push(before);
        continue;
      }
      const same =
        s.account_id == null &&
        s.from_account_id === want.from_account_id &&
        s.to_account_id === want.to_account_id &&
        isHomeCurrency(s.currency) &&
        s.counter_amount == null &&
        s.flow_kind === FLOW_KIND_PAGO_TARJETA &&
        Math.round(s.amount) === want.amount_clp &&
        s.occurred_on === want.occurred_on;
      if (same) {
        result.unchanged += 1;
        continue;
      }
      delMovement.run(s.movement_id);
      result.updated.push({ before, after: { ...want, movement_id: write(want) } });
    }
    for (const p of expected.values()) result.created.push({ ...p, movement_id: write(p) });
    return result;
  })();
}

/**
 * The boot-time pass: a database migrated before the sync ran (migration 311 created the table
 * empty) or written to while a part changed without a card write gets its transfers here. Idempotent
 * and cheap (a no-op when in step); logs only what it changed.
 */
export function syncCardToCardPaymentTransfersAtBoot(): void {
  const r = syncCardToCardPaymentTransfers();
  if (r.created.length + r.updated.length + r.deleted.length === 0) return;
  console.log(
    `[card-to-card] boot sync: ${r.created.length} transfer(s) created, ${r.updated.length} updated, ` +
      `${r.deleted.length} deleted, ${r.unchanged} unchanged`
  );
}
