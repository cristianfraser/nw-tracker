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
  | {
      kind: "dispose";
      date: string;
      movementId: number;
      units: number;
      proceeds: number;
      /** Passed through to the disposal — e.g. whether a tax rule recognizes its result now or defers it. */
      tag?: string;
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
};

/**
 * Units below this are rounding noise: a sale may exceed the holding by at most this much (the
 * broker's 8-9 decimal share counts summed as floats), and a lot left with less is closed.
 */
export const TAX_LOT_UNITS_EPS = 1e-8;

/**
 * Replays `events` in the order given (the caller sorts them; same-day order is the ledger's)
 * and returns every disposal with the purchases it consumed, plus the lots still open (oldest
 * first). `method` is a named selector or a custom one.
 * Throws on a non-positive unit count, a negative amount, or a sale larger than the holding.
 */
export function realizeTaxLots(
  events: readonly TaxLotEvent[],
  method: TaxLotMethod | TaxLotSelector
): { disposals: TaxLotDisposal[]; openLots: TaxLotSlice[] } {
  const selector = typeof method === "function" ? method : TAX_LOT_SELECTORS[method];
  const lots: TaxLotSlice[] = [];
  const disposals: TaxLotDisposal[] = [];
  let previousDate = "";
  for (const e of events) {
    if (e.date < previousDate) {
      throw new Error(`Tax lots: movement ${e.movementId} dated ${e.date} comes after ${previousDate}`);
    }
    previousDate = e.date;
    if (!(e.units > 0)) throw new Error(`Tax lots: movement ${e.movementId} has ${e.units} units`);
    if (e.kind === "acquire") {
      if (!(e.cost >= 0)) throw new Error(`Tax lots: purchase ${e.movementId} costs ${e.cost}`);
      lots.push({ acquiredOn: e.date, acquireMovementId: e.movementId, units: e.units, cost: e.cost });
      continue;
    }
    if (!(e.proceeds >= 0)) throw new Error(`Tax lots: sale ${e.movementId} returned ${e.proceeds}`);
    const held = lots.reduce((s, l) => s + l.units, 0);
    if (e.units > held + TAX_LOT_UNITS_EPS) {
      throw new Error(`Tax lots: sale ${e.movementId} on ${e.date} sells ${e.units} units but ${held} are held`);
    }
    const take = selector(lots, Math.min(e.units, held));
    if (take.length !== lots.length) throw new Error(`Tax lots: the selector returned ${take.length} amounts for ${lots.length} lots`);
    const taken = take.reduce((s, x) => s + x, 0);
    if (Math.abs(taken - Math.min(e.units, held)) > TAX_LOT_UNITS_EPS) {
      throw new Error(`Tax lots: the selector took ${taken} units for sale ${e.movementId} of ${e.units}`);
    }
    const slices: TaxLotSlice[] = [];
    take.forEach((units, i) => {
      if (units <= 0) return;
      const lot = lots[i]!;
      if (units > lot.units + TAX_LOT_UNITS_EPS) {
        throw new Error(`Tax lots: the selector took ${units} units from a lot of ${lot.units}`);
      }
      const cost = units >= lot.units ? lot.cost : (lot.cost * units) / lot.units;
      slices.push({ acquiredOn: lot.acquiredOn, acquireMovementId: lot.acquireMovementId, units, cost });
      lot.units -= units;
      lot.cost -= cost;
    });
    for (let i = lots.length - 1; i >= 0; i--) if (lots[i]!.units <= TAX_LOT_UNITS_EPS) lots.splice(i, 1);
    const cost = slices.reduce((s, x) => s + x.cost, 0);
    disposals.push({
      date: e.date,
      movementId: e.movementId,
      units: e.units,
      proceeds: e.proceeds,
      cost,
      gain: e.proceeds - cost,
      slices,
      ...(e.tag != null ? { tag: e.tag } : {}),
    });
  }
  return { disposals, openLots: lots.map((l) => ({ ...l })) };
}
