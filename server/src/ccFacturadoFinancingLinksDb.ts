import { db } from "./db.js";

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
};

const selLinks = db.prepare(
  `SELECT id, financed_account_id, financed_billing_month
     FROM cc_facturado_financing_links
     ORDER BY financed_account_id, financed_billing_month`
);

const selLinkPurchases = db.prepare(
  `SELECT link_id, financing_account_id, financing_purchase_key
     FROM cc_facturado_financing_link_purchases`
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
  return links.map((l) => ({
    id: l.id,
    financed_account_id: l.financed_account_id,
    financed_billing_month: l.financed_billing_month,
    financing: byLink.get(l.id) ?? [],
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
  `DELETE FROM cc_facturado_financing_link_purchases WHERE link_id = ?`
);
const insLinkPurchase = db.prepare(
  `INSERT OR IGNORE INTO cc_facturado_financing_link_purchases
     (link_id, financing_account_id, financing_purchase_key) VALUES (?, ?, ?)`
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
    for (const f of args.financing) {
      insLinkPurchase.run(row.id, f.account_id, f.purchase_key);
    }
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
