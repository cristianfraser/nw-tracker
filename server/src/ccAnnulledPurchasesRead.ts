/**
 * Read side of `cc_annulled_purchases` (migration 332) for the owed walk, the cupo check and the
 * expense lines. A leaf (only `db`): `ccAnnulledPurchases.ts` — the writer — reaches the expense
 * categories, which reach the billing readers that use this.
 *
 * An annulled purchase was listed by the bank from its purchase day until the day it dropped it, so
 * the card owed it `purchase_date ≤ D < annulled_on`. It was never billed: billing frames (facturado,
 * cupo en cuotas, the cuota schedule, «Próximos pagos») never read these rows.
 */
import { db } from "./db.js";
import { oneShotCardLineExpenseKey } from "./cards/oneShotLineKey.js";

export type AnnulledPurchaseRow = {
  id: number;
  account_id: number;
  currency: string;
  /** Debt-positive, in `currency`. */
  amount: number;
  merchant: string;
  purchase_date: string;
  annulled_on: string;
  basis: "feed_drop" | "cupo_gap" | "statement_close" | "manual";
  /** The line's parser row id (`parser_row_id`), from which {@link purchase_key} is rebuilt. */
  parser_row_id: string | null;
  /** The expense key the deleted bucket line carried (rebuilt, `cards/oneShotLineKey.ts`). */
  purchase_key: string;
  flow_id: number | null;
  origin_card_last4: string | null;
  /** 1 when the bank later refunded it with a real credit line: no synthetic annulment leg. */
  bank_credit: number;
};

const COLUMNS = `id, account_id, currency, amount, merchant, purchase_date, annulled_on, basis, parser_row_id, flow_id, origin_card_last4, bank_credit`;

/** A stored row with the expense key its line carried. */
export function withAnnulledPurchaseKey<T extends { account_id: number; parser_row_id: string | null; merchant: string; purchase_date: string }>(
  row: T
): T & { purchase_key: string } {
  return {
    ...row,
    purchase_key: oneShotCardLineExpenseKey({
      accountId: row.account_id,
      parserRowId: row.parser_row_id,
      merchant: row.merchant,
      purchaseIso: row.purchase_date,
    }),
  };
}

type StoredRow = Omit<AnnulledPurchaseRow, "purchase_key">;

export function annulledPurchaseRowsForAccount(accountId: number): AnnulledPurchaseRow[] {
  return (
    db
      .prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases WHERE account_id = ? ORDER BY purchase_date, id`)
      .all(accountId) as StoredRow[]
  ).map(withAnnulledPurchaseKey);
}

export function allAnnulledPurchaseRows(): AnnulledPurchaseRow[] {
  return (
    db.prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases ORDER BY account_id, purchase_date, id`).all() as StoredRow[]
  ).map(withAnnulledPurchaseKey);
}

/** What the card's listing still held on `asOfIso`, per currency: purchase_date ≤ asOf < annulled_on. */
export function annulledOwedAtYmd(accountId: number, asOfIso: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of annulledPurchaseRowsForAccount(accountId)) {
    if (a.purchase_date <= asOfIso && asOfIso < a.annulled_on) out.set(a.currency, (out.get(a.currency) ?? 0) + a.amount);
  }
  return out;
}

/**
 * The line ids of an annulled purchase's two expense lines. Negative like a plan's own lines, in a
 * range of their own (`ccInstallmentPlanGastosLines.ts` owns ids below −3·10⁹): `−(2·10⁹ + 2·id)` is
 * the purchase, one less the annulment.
 */
const ANNULLED_LINE_ID_OFFSET = 2_000_000_000;
const PLAN_LINE_ID_OFFSET = 3_000_000_000;

export function annulledPurchaseLineId(annulledPurchaseId: number, leg: "purchase" | "annulment"): number {
  return -(ANNULLED_LINE_ID_OFFSET + annulledPurchaseId * 2 + (leg === "annulment" ? 1 : 0));
}

/** The annulled purchase and leg an expense line id encodes, or null when it is not one of theirs. */
export function annulledPurchaseOfLineId(lineId: number): { annulledPurchaseId: number; leg: "purchase" | "annulment" } | null {
  if (lineId > -ANNULLED_LINE_ID_OFFSET || lineId <= -PLAN_LINE_ID_OFFSET) return null;
  const n = -lineId - ANNULLED_LINE_ID_OFFSET;
  return { annulledPurchaseId: Math.floor(n / 2), leg: n % 2 === 1 ? "annulment" : "purchase" };
}

/** The expense key an annulled purchase's line carries (the key its deleted bucket line carried). */
export function annulledPurchaseKeyFor(annulledPurchaseId: number): string {
  const row = db.prepare(`SELECT ${COLUMNS} FROM cc_annulled_purchases WHERE id = ?`).get(annulledPurchaseId) as
    | StoredRow
    | undefined;
  if (!row) throw new Error(`annulled purchase ${annulledPurchaseId} does not exist`);
  return withAnnulledPurchaseKey(row).purchase_key;
}
