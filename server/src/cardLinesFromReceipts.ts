/**
 * Card lines estimated from receipts (docs/untangle-flow-model.md C; user decision 2026-11-08): for a
 * month a card has no statement for, a receipt no card line pairs with is the only record of that
 * purchase. Pure: the script (`scripts/estimate-card-lines-from-receipts.ts`) reads the receipts,
 * the matcher's result and the ledger, this module decides, the script writes through the card
 * line funnel.
 *
 * - {@link gapBillingMonths}: a card's months without a statement — before its first (from a date
 *   the user names: the card's start), between two statements, and the months whose statement was
 *   rebuilt from mails (its estimated weekly lumps can be itemized).
 * - {@link attributeToCard}: which card a receipt belongs to — the one that carried the same
 *   merchant in the nearest statement months; a tie is ambiguous and nothing is written.
 * - {@link shrinkLumpsByItems}: a rebuilt month's estimated lumps lose what the receipts itemize, so
 *   the statement's billed total is unchanged; a lump that would not cover its items fails.
 */

export type GapMonthKind = "before_first" | "between" | "rebuilt";
export type GapMonth = { month: string; kind: GapMonthKind };

function monthRange(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let [y, m] = fromYm.split("-").map(Number) as [number, number];
  const [ty, tm] = toYm.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Whole months between two `YYYY-MM` (b − a). */
export function monthDistance(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/**
 * A card's gap months: every month from `since` to the first statement month (exclusive), every
 * month between the first and the last statement month with no statement, and the rebuilt months
 * (statements that exist, from mails). Months after the last statement are the open bucket's, not
 * gaps. `since` after the first statement month means no month before it.
 */
export function gapBillingMonths(statementMonths: readonly string[], rebuiltMonths: readonly string[], since: string): GapMonth[] {
  if (!/^\d{4}-\d{2}$/.test(since)) throw new Error(`gap months: since must be YYYY-MM, got ${since}`);
  const months = [...new Set(statementMonths)].sort();
  if (months.length === 0) return [];
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const have = new Set(months);
  const rebuilt = new Set(rebuiltMonths);
  const out: GapMonth[] = [];
  if (since < first) for (const m of monthRange(since, first)) if (m !== first) out.push({ month: m, kind: "before_first" });
  for (const m of monthRange(first, last)) {
    if (!have.has(m)) out.push({ month: m, kind: "between" });
    else if (rebuilt.has(m)) out.push({ month: m, kind: "rebuilt" });
  }
  return out;
}

export type CardMerchantMonths = {
  account_id: number;
  /** The statement months in which a line of the card matched the receipt's merchant. */
  merchant_months: readonly string[];
};

export type Attribution =
  | { kind: "card"; account_id: number; distance_months: number }
  | { kind: "ambiguous"; account_ids: number[] }
  | { kind: "none" };

/**
 * The card a receipt of `month` belongs to, among the cards with a gap at that month: the one whose
 * nearest statement month carrying the merchant is nearest; two at the same distance are ambiguous;
 * a merchant no candidate ever carried names no card.
 */
export function attributeToCard(month: string, candidates: readonly CardMerchantMonths[]): Attribution {
  const scored = candidates
    .map((c) => ({ account_id: c.account_id, distance: Math.min(...c.merchant_months.map((m) => Math.abs(monthDistance(month, m)))) }))
    .filter((c) => Number.isFinite(c.distance))
    .sort((a, b) => a.distance - b.distance || a.account_id - b.account_id);
  if (scored.length === 0) return { kind: "none" };
  const best = scored.filter((c) => c.distance === scored[0]!.distance);
  if (best.length > 1) return { kind: "ambiguous", account_ids: best.map((b) => b.account_id) };
  return { kind: "card", account_id: best[0]!.account_id, distance_months: best[0]!.distance };
}

export type Lump = { date: string; amount: number };

/**
 * The lumps of a rebuilt month after the receipts itemize part of them: each item goes to a lump of
 * its own bucket — by default its calendar month; the caller's `bucketOf` can add the side of a
 * statement close, so that no pesos cross a month-end or a close and the month-end anchors beside
 * the rebuilt statement stay where they are — the first lump dated on or after it, else the bucket's
 * last. Σ lumps shrinks by Σ items, so the statement's total is unchanged. An item with no lump in
 * its bucket, or a lump that would not stay above 0, throws: the estimate cannot be itemized that way
 * (the caller sets such items aside and reports them).
 */
export function shrinkLumpsByItems(
  lumps: readonly Lump[],
  items: readonly { date: string; amount: number }[],
  bucketOf: (date: string) => string = (d) => d.slice(0, 7)
): Lump[] {
  if (lumps.length === 0 && items.length > 0) throw new Error("no estimated lump to itemize");
  const out = [...lumps].sort((a, b) => a.date.localeCompare(b.date)).map((l) => ({ ...l }));
  for (const item of items) {
    const pool = out.filter((l) => bucketOf(l.date) === bucketOf(item.date));
    if (pool.length === 0) throw new Error(`no estimated lump in the bucket of ${item.date} (${bucketOf(item.date)})`);
    const target = pool.find((l) => l.date >= item.date) ?? pool[pool.length - 1]!;
    target.amount -= item.amount;
    if (target.amount <= 0) {
      throw new Error(`the estimated lump of ${target.date} does not cover the receipts itemized into it (left ${target.amount})`);
    }
  }
  return out;
}

/** Whether every item has a lump in its bucket (the ones that do not are left out of the itemizing). */
export function itemsWithLumpInBucket<T extends { date: string }>(
  lumps: readonly Lump[],
  items: readonly T[],
  bucketOf: (date: string) => string
): { itemizable: T[]; stranded: T[] } {
  const buckets = new Set(lumps.map((l) => bucketOf(l.date)));
  const itemizable: T[] = [];
  const stranded: T[] = [];
  for (const i of items) (buckets.has(bucketOf(i.date)) ? itemizable : stranded).push(i);
  return { itemizable, stranded };
}
