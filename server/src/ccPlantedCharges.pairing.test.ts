/**
 * The planted-charge absorber runs on the shared `pairOneToOne` helper (`first` for the listing's
 * own-day lines, `nearest` for the line the import is about to write). This file keeps the loop it
 * replaced — «the pre-wave-7 rule» — as a reference and feeds both the same randomised listings:
 * the same planted line absorbs the same listing line, in the same order.
 */
import { describe, expect, it } from "vitest";
import { addDaysIso, daysBetweenIso, dayWithinWindow } from "nw-tracker-contracts";
import { absorberForPlanted, type ChargeFacts, type Planted, type PlantedSamePurchase } from "./ccPlantedCharges.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import { seededRandom } from "./matching/seededRandom.js";

/** The pre-wave-7 rule: the absorber's own loops (money compared to the cent in every currency). */
function preWave7Absorber(planted: readonly Planted[], listing: readonly ChargeFacts[]) {
  const sameMoney = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
  const samePurchase = (p: Planted, c: ChargeFacts) =>
    p.currency === c.currency && sameMoney(p.amount, c.amount) && merchantsMatchForCrossDedupe(p.merchant, c.merchant);
  const used = new Set<number>();
  for (const c of listing) {
    if (!c.date || c.amount <= 0) continue;
    const p = planted.find((x) => !used.has(x.line_id) && x.date === c.date && samePurchase(x, c));
    if (p) used.add(p.line_id);
  }
  const absorbed: PlantedSamePurchase[] = [];
  return {
    absorbed,
    absorb(c: ChargeFacts): Planted | null {
      if (!c.date || c.amount <= 0) return null;
      let best: Planted | null = null;
      for (const p of planted) {
        if (used.has(p.line_id) || !samePurchase(p, c)) continue;
        if (!dayWithinWindow(p.date, c.date, { daysBefore: 0, daysAfter: 3 })) continue;
        if (!best || daysBetweenIso(p.date, c.date) < daysBetweenIso(best.date, c.date)) best = p;
      }
      if (!best) return null;
      used.add(best.line_id);
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

const DAY0 = "2031-05-10";
// Names the cross-dedupe rule reads as one shop (a listing's cut, a statement's suffix) and as others.
const MERCHANTS = ["ALMACEN CENTRAL, SANTIAGO", "ALMACEN CENTRAL", "ALMACEN CENTR", "FERRETERIA NORTE", "FARMACIA SUR 123", null];
const AMOUNTS: Record<string, number[]> = { clp: [11670, 11671, 45990], usd: [12.5, 12.51, 80] };

describe("planted charges: pairOneToOne reproduces the pre-wave-7 rule", () => {
  it("600 random listings: the same planted line absorbs the same listing line", () => {
    const r = seededRandom(11670);
    let absorbedTotal = 0;
    let ownDayTotal = 0;
    for (let n = 0; n < 600; n++) {
      const currencies = r.chance(0.6) ? ["clp"] : ["clp", "usd"];
      const charge = (): { currency: string; amount: number; merchant: string | null } => {
        const currency = r.pick(currencies);
        return { currency, amount: r.pick(AMOUNTS[currency]!), merchant: r.pick(MERCHANTS) };
      };
      // Planted lines in line-id order, as the loader reads them; twins (same day, same purchase) happen.
      const planted: Planted[] = [];
      for (let i = r.int(0, 5); i > 0; i--) {
        const base = planted.length > 0 && r.chance(0.3) ? r.pick(planted) : { ...charge(), date: addDaysIso(DAY0, r.int(0, 4)) };
        planted.push({ ...base, line_id: 500 + planted.length });
      }
      const listing: ChargeFacts[] = [];
      for (let i = r.int(0, 7); i > 0; i--) {
        if (planted.length > 0 && r.chance(0.6)) {
          // The bank's listing of a planted purchase: its own day, a later posting day, the window's
          // edge (3), just past it (4), or the day before.
          const p = r.pick(planted);
          const merchant = r.chance(0.7) ? p.merchant : r.pick(MERCHANTS);
          listing.push({ currency: p.currency, amount: p.amount, merchant, date: addDaysIso(p.date, r.pick([0, 0, 1, 2, 3, 3, 4, -1])) });
        } else {
          const c = charge();
          listing.push({ ...c, date: r.chance(0.05) ? null : addDaysIso(DAY0, r.int(-1, 9)), amount: r.chance(0.1) ? -c.amount : c.amount });
        }
        if (r.chance(0.2)) listing.push({ ...listing[listing.length - 1]! });
      }
      // The import asks about the lines it would write: not every line (a key duplicate never asks).
      const asked = listing.filter(() => r.chance(0.75));

      const before = preWave7Absorber(planted, listing);
      const after = absorberForPlanted(planted, listing);
      for (const c of asked) {
        expect(after.absorb(c)?.line_id ?? null, `case ${n}`).toBe(before.absorb(c)?.line_id ?? null);
      }
      expect(after.absorbed, `case ${n}`).toEqual(before.absorbed);
      absorbedTotal += before.absorbed.length;
      ownDayTotal += before.absorbed.filter((a) => a.listing_date === a.planted_date).length;
    }
    expect(absorbedTotal).toBeGreaterThan(150);
    // A twin planted the same day leaves one line free for the listing's second same-day row.
    expect(ownDayTotal).toBeGreaterThan(5);
  });
});
