import { db } from "./db.js";
import { expenseKeySql } from "./expenseKeys.js";
import { keyTarget, targetParams } from "./flows/flowKeyedAssignments.js";

/**
 * A facturado-financing link: one financed facturado (account + billing month) jointly paid by a
 * set of installment purchases (identified by stable `purchase_key`). See migration 145 and
 * ccFacturadoFinancingProjectionLines.ts.
 */
export type CcFacturadoFinancingLink = {
  id: number;
  financed_account_id: number;
  financed_billing_month: string;
  financing: { account_id: number; purchase_key: string }[];
  /**
   * The purchases that paid part (or all) of the facturado in one charge (migration 297), by flow;
   * empty for a link made by hand. The plans financed the facturado less their sum.
   */
  charges?: { account_id: number; flow_id: number; amount_clp: number }[];
};

const selCharges = db.prepare(
  `SELECT financing_link_id AS link_id, account_id, flow_id, amount_clp
     FROM cc_facturado_payment_charges ORDER BY rowid`
);

const selLinks = db.prepare(
  `SELECT id, financed_account_id, financed_billing_month
     FROM cc_facturado_financing_links
     ORDER BY financed_account_id, financed_billing_month`
);

/** The plans of each link: the `finances_facturado` links on their flows (migration 284), read under their keys. */
const selLinkPurchases = db.prepare(
  `SELECT a.financing_link_id AS link_id, a.account_id AS financing_account_id,
          ${expenseKeySql("f.legacy_key", "a.portion", "NULLIF(a.piece_seq, -1)")} AS financing_purchase_key
     FROM flow_links a JOIN flows f ON f.id = a.flow_id
     WHERE a.kind = 'finances_facturado'
     ORDER BY a.rowid`
);

/** All links with their financing purchases. */
export function listCcFacturadoFinancingLinks(): CcFacturadoFinancingLink[] {
  const links = selLinks.all() as {
    id: number;
    financed_account_id: number;
    financed_billing_month: string;
  }[];
  const byLink = new Map<number, { account_id: number; purchase_key: string }[]>();
  for (const row of selLinkPurchases.all() as {
    link_id: number;
    financing_account_id: number;
    financing_purchase_key: string;
  }[]) {
    const list = byLink.get(row.link_id) ?? [];
    list.push({ account_id: row.financing_account_id, purchase_key: row.financing_purchase_key });
    byLink.set(row.link_id, list);
  }
  const chargesByLink = new Map<number, NonNullable<CcFacturadoFinancingLink["charges"]>>();
  for (const c of selCharges.all() as { link_id: number; account_id: number; flow_id: number; amount_clp: number }[]) {
    const list = chargesByLink.get(c.link_id) ?? [];
    list.push({ account_id: c.account_id, flow_id: c.flow_id, amount_clp: c.amount_clp });
    chargesByLink.set(c.link_id, list);
  }
  return links.map((l) => ({
    id: l.id,
    financed_account_id: l.financed_account_id,
    financed_billing_month: l.financed_billing_month,
    financing: byLink.get(l.id) ?? [],
    charges: chargesByLink.get(l.id) ?? [],
  }));
}

const insLink = db.prepare(
  `INSERT OR IGNORE INTO cc_facturado_financing_links (financed_account_id, financed_billing_month)
     VALUES (?, ?)`
);
const selLinkId = db.prepare(
  `SELECT id FROM cc_facturado_financing_links
     WHERE financed_account_id = ? AND financed_billing_month = ?`
);
const delLinkPurchases = db.prepare(
  `DELETE FROM flow_links WHERE kind = 'finances_facturado' AND financing_link_id = ?`
);
const delCharges = db.prepare(`DELETE FROM cc_facturado_payment_charges WHERE financing_link_id = ?`);
const insLinkPurchase = db.prepare(
  `INSERT OR IGNORE INTO flow_links (flow_id, portion, piece_seq, kind, financing_link_id, account_id)
     VALUES (?, ?, ?, 'finances_facturado', ?, ?)`
);

/**
 * Create or replace a link for `(financedAccountId, financedBillingMonth)` with the given financing
 * purchases. Replaces any existing financing set for that facturado.
 */
export function upsertCcFacturadoFinancingLink(args: {
  financedAccountId: number;
  financedBillingMonth: string;
  financing: { account_id: number; purchase_key: string }[];
}): { id: number } {
  if (!/^\d{4}-\d{2}$/.test(args.financedBillingMonth)) {
    throw new Error("financed_billing_month must be YYYY-MM");
  }
  if (args.financing.length === 0) {
    throw new Error("at least one financing purchase is required");
  }
  const run = db.transaction(() => {
    insLink.run(args.financedAccountId, args.financedBillingMonth);
    const row = selLinkId.get(args.financedAccountId, args.financedBillingMonth) as { id: number };
    delLinkPurchases.run(row.id);
    // A link made by hand states the whole financing: a match's one-shot charges go with it.
    delCharges.run(row.id);
    for (const f of args.financing) {
      insLinkPurchase.run(...targetParams(keyTarget(f.purchase_key, true)), row.id, f.account_id);
    }
    return row.id;
  });
  return { id: run() };
}

const insCharge = db.prepare(
  `INSERT INTO cc_facturado_payment_charges (financing_link_id, flow_id, account_id, amount_clp) VALUES (?, ?, ?, ?)`
);

/**
 * Records how a facturado was paid, as the matcher found it (`ccFacturadoFinancingAuto.ts`): its
 * link row, the plans as its financing purchases and the one-shot charges by flow. Refuses a
 * facturado already recorded — a match is made once and never rewritten.
 */
export function recordCcFacturadoPayment(args: {
  financedAccountId: number;
  financedBillingMonth: string;
  plans: { account_id: number; purchase_key: string }[];
  charges: { account_id: number; flow_id: number; amount_clp: number }[];
}): { id: number } {
  if (!/^\d{4}-\d{2}$/.test(args.financedBillingMonth)) throw new Error("financed_billing_month must be YYYY-MM");
  if (args.plans.length + args.charges.length === 0) throw new Error("a facturado payment needs at least one purchase");
  const run = db.transaction(() => {
    if (selLinkId.get(args.financedAccountId, args.financedBillingMonth)) {
      throw new Error(`facturado ${args.financedAccountId}|${args.financedBillingMonth} already has a payment record`);
    }
    insLink.run(args.financedAccountId, args.financedBillingMonth);
    const row = selLinkId.get(args.financedAccountId, args.financedBillingMonth) as { id: number };
    for (const f of args.plans) {
      insLinkPurchase.run(...targetParams(keyTarget(f.purchase_key, true)), row.id, f.account_id);
    }
    for (const c of args.charges) insCharge.run(row.id, c.flow_id, c.account_id, c.amount_clp);
    return row.id;
  });
  return { id: run() };
}

const delLink = db.prepare(`DELETE FROM cc_facturado_financing_links WHERE id = ?`);

/** Remove a link and its financing purchases. */
export function deleteCcFacturadoFinancingLink(id: number): void {
  const run = db.transaction(() => {
    delLinkPurchases.run(id);
    delLink.run(id);
  });
  run();
}
