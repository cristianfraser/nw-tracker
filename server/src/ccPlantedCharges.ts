/**
 * Card charge lines the app planted before the bank listed the purchase (migration 328,
 * `cc_planted_charge_lines`), and the bank's later listing of the same purchase.
 *
 * A grocery receipt paid with the Lider card writes its line the day of the purchase
 * (`storeReceiptApply.ts`, batch kind `cc_lider_boleta`), a lender's receipt its cuota charge
 * (`mortgagePaymentReceiptsApply.ts`, `cc_lender_receipt`). Both are written under the merchant the
 * bank prints, so when the bank lists the purchase the same day its line dedupes on the one-shot key
 * (or as a fuzzy twin: the lender's name cut by the site). But the bank sometimes lists a purchase on
 * a later posting day: a boleta of Saturday 07/11 (printed 17:06) came back as «EXPRESS LYON,
 * SANTIAGO» 1x.xxx dated Monday 09/11, and imported as a second charge (the bank's cupo was off by
 * exactly that). Other boletas, a Sunday 20:30 one included, were listed on their own day.
 *
 * So a listing line the import would write is that purchase when a planted line on the same card
 * (any listing bucket) has the same currency and amount, a matching merchant
 * (`merchantsMatchForCrossDedupe`) and is dated from `MATCH_WINDOWS.planted_charge` days before the
 * listing line to the same day. One-to-one: a planted line absorbs at most one listing line, and a
 * planted line the same listing shows on its own day (a key or fuzzy duplicate) absorbs none — the
 * later same-amount line is another purchase. A twin the listing carries (`#dupN`) still imports
 * once the planted lines are used up. The planted line stays the card's one charge; the statement
 * settles it like any bucket line.
 */
import { db } from "./db.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { daysBetweenIso, dayWithinWindow } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { pairOneToOne } from "./matching/pairing.js";
import { sameCoin } from "./matching/money.js";

/** Import batch kinds that plant a charge line (never absorbed against themselves). */
export const PLANTED_CHARGE_SOURCES = ["cc_lider_boleta", "cc_lender_receipt"] as const;
export type PlantedChargeSource = (typeof PLANTED_CHARGE_SOURCES)[number];

export function isPlantedChargeSource(kind: string | null | undefined): kind is PlantedChargeSource {
  return kind != null && (PLANTED_CHARGE_SOURCES as readonly string[]).includes(kind);
}

export function recordPlantedChargeLine(lineId: number, accountId: number, source: PlantedChargeSource): void {
  db.prepare(`INSERT OR IGNORE INTO cc_planted_charge_lines (line_id, account_id, source) VALUES (?, ?, ?)`).run(
    lineId,
    accountId,
    source
  );
}

/** A charge as the import compares it: its currency, amount in it, merchant and ISO day. */
export type ChargeFacts = { currency: string; amount: number; merchant: string | null; date: string | null };

export type Planted = { line_id: number; currency: string; amount: number; merchant: string | null; date: string };

export type PlantedSamePurchase = {
  planted_line_id: number;
  merchant: string | null;
  listing_date: string;
  planted_date: string;
  currency: string;
  amount: number;
};

function samePurchase(p: Planted, c: ChargeFacts): boolean {
  return p.currency === c.currency && sameCoin(p.amount, c.amount, p.currency) && merchantsMatchForCrossDedupe(p.merchant, c.merchant);
}

export type PlantedChargeAbsorber = {
  /** The planted line this listing line is (it is then skipped), or null to import it. */
  absorb(line: ChargeFacts): Planted | null;
  absorbed: PlantedSamePurchase[];
};

/**
 * The account's planted charge lines, with those `listing` (every line of this import) already
 * shows on their own day taken out, one listing line each.
 */
export function plantedChargeAbsorber(accountId: number, listing: readonly ChargeFacts[]): PlantedChargeAbsorber {
  const rows = db
    .prepare(
      `SELECT l.id AS line_id, l.currency, l.amount, l.merchant, l.transaction_date
       FROM cc_planted_charge_lines p
       JOIN cc_statement_lines l ON l.id = p.line_id
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE p.account_id = ? AND s.account_id = ? AND s.source_kind IN ('listing_open', 'listing_other')
         AND l.installment_flag = 0 AND l.amount > 0
       ORDER BY l.id`
    )
    .all(accountId, accountId) as { line_id: number; currency: string; amount: number; merchant: string | null; transaction_date: string | null }[];
  const planted: Planted[] = [];
  for (const r of rows) {
    const date = normalizeTransactionDateIso(r.transaction_date);
    if (date) planted.push({ line_id: r.line_id, currency: r.currency, amount: r.amount, merchant: r.merchant, date });
  }
  return absorberForPlanted(planted, listing);
}

/**
 * The absorber over planted lines already loaded (in line-id order). Pure: the pairing rule alone.
 *
 * Two pairings on the shared helper. First the listing's own-day lines, in listing order, each
 * taking the first free planted line of its day (`first`): those planted lines are spoken for.
 * Then each line the import would write, as the import reaches it, takes the nearest free planted
 * line inside the window (`nearest`; planted lines equally near cannot be told apart by the
 * listing, so the lowest line id pairs).
 */
export function absorberForPlanted(planted: readonly Planted[], listing: readonly ChargeFacts[]): PlantedChargeAbsorber {
  type Dated = ChargeFacts & { date: string };
  const isCharge = (c: ChargeFacts): c is Dated => c.date != null && c.date !== "" && c.amount > 0;
  // Lines of this listing dated the planted day are that line's own listing (key or fuzzy duplicate).
  const ownDay = pairOneToOne(listing.filter(isCharge), planted, {
    strategy: "first",
    accepts: (c, p) => p.date === c.date && samePurchase(p, c),
  });
  const used = new Set<Planted>(ownDay.pairs.map((x) => x.right));
  const absorbed: PlantedSamePurchase[] = [];
  return {
    absorbed,
    absorb(c) {
      if (!isCharge(c)) return null;
      const { pairs } = pairOneToOne(
        [c],
        planted.filter((p) => !used.has(p)),
        {
          strategy: "nearest",
          accepts: (line, p) => samePurchase(p, line) && dayWithinWindow(p.date, line.date, MATCH_WINDOWS.planted_charge),
          distance: (line, p) => daysBetweenIso(p.date, line.date),
          twins: () => true,
        }
      );
      const best = pairs[0]?.right;
      if (!best) return null;
      used.add(best);
      absorbed.push({
        planted_line_id: best.line_id,
        merchant: c.merchant,
        listing_date: c.date,
        planted_date: best.date,
        currency: c.currency,
        amount: c.amount,
      });
      return best;
    },
  };
}
