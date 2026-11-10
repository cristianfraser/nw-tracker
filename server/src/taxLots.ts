/**
 * Purchase lots and what each sale consumed — the cost basis a tax authority asks for when an
 * asset bought in several purchases is sold. The method is a parameter, because it is the tax
 * rule's choice, not the ledger's: Chile's SII accepts identifying the units sold, FIFO or LIFO,
 * and rejects weighted average cost (Circular 43/2021 §4.5; Oficio 233/2018); other
 * jurisdictions use average cost. A method is a {@link TaxLotSelector}; the named ones are
 * {@link TAX_LOT_SELECTORS}, and another rule (specific identification, …) is one more selector.
 *
 * Amounts stay in the currency the asset was bought and sold in; converting them to pesos (fx
 * date, IPC reajuste) is the tax rule's business, applied per slice by the caller, which is why
 * every slice keeps the date and movement of the purchase it came from.
 */

/**
 * How much of each open lot (oldest first) a sale of `units` consumes; the amounts must add up to
 * `units` and none may exceed its lot. Pure: it sees the lots and the sale, nothing else.
 */
export type TaxLotSelector = (openLots: readonly TaxLotSlice[], units: number) => number[];

function takeInOrder(openLots: readonly TaxLotSlice[], units: number, newestFirst: boolean): number[] {
  const take = openLots.map(() => 0);
  let remaining = units;
  for (let k = 0; k < openLots.length && remaining > 0; k++) {
    const i = newestFirst ? openLots.length - 1 - k : k;
    take[i] = Math.min(openLots[i]!.units, remaining);
    remaining -= take[i]!;
  }
  return take;
}

export const TAX_LOT_SELECTORS = {
  /** Oldest purchase first. */
  fifo: (lots: readonly TaxLotSlice[], units: number) => takeInOrder(lots, units, false),
  /** Newest purchase first. */
  lifo: (lots: readonly TaxLotSlice[], units: number) => takeInOrder(lots, units, true),
  /**
   * Weighted average cost: every open lot gives up the same fraction, so the cost of a sale is
   * the pool's average cost × units, while each slice still carries its purchase date.
   */
  average: (lots: readonly TaxLotSlice[], units: number) => {
    const held = lots.reduce((s, l) => s + l.units, 0);
    const fraction = Math.min(1, units / held);
    return lots.map((l) => l.units * fraction);
  },
} satisfies Record<string, TaxLotSelector>;

export type TaxLotMethod = keyof typeof TAX_LOT_SELECTORS;

export type TaxLotEvent =
  | { kind: "acquire"; date: string; movementId: number; units: number; cost: number }
  /**
   * A SHORT lot opens: `units` sold before they were held (a written option), `proceeds`
   * received. Shorts are their own pool, never inferred: a `dispose` with no long lot to take
   * from throws, it does not go short.
   */
  | { kind: "open_short"; date: string; movementId: number; units: number; proceeds: number }
  /**
   * Short units are closed: bought back (`cost` paid), expired (`cost` 0) or settled by an
   * assignment (`assigned`: the lot closes with no gain of its own — the premium it received
   * travels to the settling trade, see `optionTaxLotEvents.ts` — and `cost` must be 0).
   */
  | { kind: "close_short"; date: string; movementId: number; units: number; cost: number; assigned?: boolean }
  /**
   * A stock split: every open lot's units × `ratio`, its cost and purchase date unchanged (a
   * split realizes nothing). `units` is the shares it added, for the ledger check.
   */
  | { kind: "split"; date: string; movementId: number; units: number; ratio: number }
  | {
      kind: "dispose";
      date: string;
      movementId: number;
      units: number;
      proceeds: number;
      /** Passed through to the disposal — e.g. whether a tax rule recognizes its result now or defers it. */
      tag?: string;
      /**
       * The lot is given up by an exercise: the disposal realizes nothing (`proceeds` must be 0,
       * the gain is 0) and its cost is what travels to the settling trade.
       */
      exercised?: boolean;
    };

/** Part of one purchase: all of it while open, the consumed part inside a disposal (listed oldest purchase first). */
export type TaxLotSlice = {
  acquiredOn: string;
  acquireMovementId: number;
  units: number;
  cost: number;
};

export type TaxLotDisposal = {
  date: string;
  movementId: number;
  units: number;
  proceeds: number;
  cost: number;
  gain: number;
  slices: TaxLotSlice[];
  tag?: string;
  /** Set only on a disposal by exercise: `gain` is 0 and `cost` is the premium carried to the settling trade. */
  exercised?: true;
};

/** Part of one short lot: `proceeds` is what its opening received (a slice's `cost` field, mirrored). */
export type ShortLotSlice = {
  openedOn: string;
  openMovementId: number;
  units: number;
  proceeds: number;
};

/** One closing of short units: what the opening received less what the closing cost. */
export type ShortLotRealization = {
  /** Date of the closing (buy-back, expiry or assignment). */
  date: string;
  movementId: number;
  units: number;
  proceeds: number;
  cost: number;
  /** `proceeds − cost`; 0 when `assigned` (the premium moves to the settling trade). */
  gain: number;
  assigned?: true;
  slices: ShortLotSlice[];
};

/**
 * The holding-period term of a result. A short position's result is always short-term (IRC
 * §1234(b)(1)); a long one is long-term when held MORE than one year — closed after the date
 * one year past the opening (a Feb 29 opening counts from Mar 1).
 */
export function taxLotTerm(openedOn: string, closedOn: string, side: "long" | "short"): "short_term" | "long_term" {
  if (side === "short") return "short_term";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openedOn) || !/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) {
    throw new Error(`Tax lots: term of ${openedOn} → ${closedOn} needs ISO dates`);
  }
  const d = new Date(`${openedOn}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return closedOn > d.toISOString().slice(0, 10) ? "long_term" : "short_term";
}

/**
 * Units below this are rounding noise: a sale may exceed the holding by at most this much (the
 * broker's 8-9 decimal share counts summed as floats), and a lot left with less is closed.
 */
export const TAX_LOT_UNITS_EPS = 1e-8;

/** The selector's amounts for `units` out of `pool`, checked. */
function takeFrom(pool: readonly TaxLotSlice[], selector: TaxLotSelector, units: number, what: string): number[] {
  const take = selector(pool, units);
  if (take.length !== pool.length) throw new Error(`Tax lots: the selector returned ${take.length} amounts for ${pool.length} lots`);
  const taken = take.reduce((s, x) => s + x, 0);
  if (Math.abs(taken - units) > TAX_LOT_UNITS_EPS) throw new Error(`Tax lots: the selector took ${taken} units for ${what} of ${units}`);
  return take;
}

/** Removes `take` from `pool` (cost pro rata), drops emptied lots and returns the consumed slices. */
function consume(pool: TaxLotSlice[], take: readonly number[]): TaxLotSlice[] {
  const slices: TaxLotSlice[] = [];
  take.forEach((units, i) => {
    if (units <= 0) return;
    const lot = pool[i]!;
    if (units > lot.units + TAX_LOT_UNITS_EPS) {
      throw new Error(`Tax lots: the selector took ${units} units from a lot of ${lot.units}`);
    }
    const cost = units >= lot.units ? lot.cost : (lot.cost * units) / lot.units;
    slices.push({ acquiredOn: lot.acquiredOn, acquireMovementId: lot.acquireMovementId, units, cost });
    lot.units -= units;
    lot.cost -= cost;
  });
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i]!.units <= TAX_LOT_UNITS_EPS) pool.splice(i, 1);
  return slices;
}

/**
 * Replays `events` in the order given (the caller sorts them; same-day order is the ledger's)
 * and returns every disposal with the purchases it consumed, plus the lots still open (oldest
 * first). `method` is a named selector or a custom one.
 * Throws on a non-positive unit count, a negative amount, or a sale larger than the holding.
 */
export function realizeTaxLots(
  events: readonly TaxLotEvent[],
  method: TaxLotMethod | TaxLotSelector
): {
  disposals: TaxLotDisposal[];
  openLots: TaxLotSlice[];
  /** Every closing of short units, in event order (empty without `open_short` events). */
  shortCloses: ShortLotRealization[];
  /** Short units still open (oldest first); `cost` on a slice is the proceeds its opening received. */
  openShortLots: ShortLotSlice[];
} {
  const selector = typeof method === "function" ? method : TAX_LOT_SELECTORS[method];
  const lots: TaxLotSlice[] = [];
  const shorts: TaxLotSlice[] = [];
  const shortCloses: ShortLotRealization[] = [];
  const disposals: TaxLotDisposal[] = [];
  let previousDate = "";
  for (const e of events) {
    if (e.date < previousDate) {
      throw new Error(`Tax lots: movement ${e.movementId} dated ${e.date} comes after ${previousDate}`);
    }
    previousDate = e.date;
    if (e.kind === "split") {
      if (!(e.ratio > 0)) throw new Error(`Tax lots: split ${e.movementId} has ratio ${e.ratio}`);
      for (const l of lots) l.units *= e.ratio;
      continue;
    }
    if (!(e.units > 0)) throw new Error(`Tax lots: movement ${e.movementId} has ${e.units} units`);
    if (e.kind === "acquire") {
      if (!(e.cost >= 0)) throw new Error(`Tax lots: purchase ${e.movementId} costs ${e.cost}`);
      lots.push({ acquiredOn: e.date, acquireMovementId: e.movementId, units: e.units, cost: e.cost });
      continue;
    }
    if (e.kind === "open_short") {
      if (!(e.proceeds >= 0)) throw new Error(`Tax lots: short opening ${e.movementId} received ${e.proceeds}`);
      // A short lot reuses the slice shape: `acquiredOn` is its opening day, `cost` its proceeds.
      shorts.push({ acquiredOn: e.date, acquireMovementId: e.movementId, units: e.units, cost: e.proceeds });
      continue;
    }
    if (e.kind === "close_short") {
      if (!(e.cost >= 0)) throw new Error(`Tax lots: short closing ${e.movementId} costs ${e.cost}`);
      if (e.assigned && e.cost !== 0) throw new Error(`Tax lots: assigned short closing ${e.movementId} must cost 0, not ${e.cost}`);
      const open = shorts.reduce((s, l) => s + l.units, 0);
      if (e.units > open + TAX_LOT_UNITS_EPS) {
        throw new Error(`Tax lots: closing ${e.movementId} on ${e.date} closes ${e.units} short units but ${open} are open`);
      }
      const closing = Math.min(e.units, open);
      const take = takeFrom(shorts, selector, closing, `short closing ${e.movementId}`);
      const taken = consume(shorts, take);
      const proceeds = taken.reduce((s, x) => s + x.cost, 0);
      shortCloses.push({
        date: e.date,
        movementId: e.movementId,
        units: e.units,
        proceeds,
        cost: e.cost,
        gain: e.assigned ? 0 : proceeds - e.cost,
        ...(e.assigned ? { assigned: true as const } : {}),
        slices: taken.map((x) => ({ openedOn: x.acquiredOn, openMovementId: x.acquireMovementId, units: x.units, proceeds: x.cost })),
      });
      continue;
    }
    if (!(e.proceeds >= 0)) throw new Error(`Tax lots: sale ${e.movementId} returned ${e.proceeds}`);
    if (e.exercised && e.proceeds !== 0) throw new Error(`Tax lots: exercised lot ${e.movementId} must have 0 proceeds, not ${e.proceeds}`);
    const held = lots.reduce((s, l) => s + l.units, 0);
    if (e.units > held + TAX_LOT_UNITS_EPS) {
      throw new Error(`Tax lots: sale ${e.movementId} on ${e.date} sells ${e.units} units but ${held} are held`);
    }
    const take = takeFrom(lots, selector, Math.min(e.units, held), `sale ${e.movementId}`);
    const slices: TaxLotSlice[] = consume(lots, take);
    const cost = slices.reduce((s, x) => s + x.cost, 0);
    disposals.push({
      date: e.date,
      movementId: e.movementId,
      units: e.units,
      proceeds: e.proceeds,
      cost,
      gain: e.exercised ? 0 : e.proceeds - cost,
      slices,
      ...(e.tag != null ? { tag: e.tag } : {}),
      ...(e.exercised ? { exercised: true as const } : {}),
    });
  }
  return {
    disposals,
    openLots: lots.map((l) => ({ ...l })),
    shortCloses,
    openShortLots: shorts.map((l) => ({ openedOn: l.acquiredOn, openMovementId: l.acquireMovementId, units: l.units, proceeds: l.cost })),
  };
}
