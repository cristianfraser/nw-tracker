/**
 * The one-to-one pairing helper: every matcher that pairs two lists of records, each record used
 * at most once, runs on this. A rule says which pairs are acceptable (`accepts`, which carries the
 * window and the money test), how far apart they are (`distance`, in days unless the caller says
 * otherwise) and which of the three declared strategies picks among the acceptable ones:
 *
 *  - `first`: walk the lefts in order; the first unclaimed acceptable right (in input order) pairs.
 *    The greedy order of matchers that never compared candidates — kept, declared, where the
 *    outcome of nearest-first was not proven identical.
 *  - `unique`: walk the lefts in order; a left with exactly one unclaimed acceptable right pairs
 *    with it, several are REPORTED as ambiguous and stay unpaired, none stay unpaired.
 *  - `nearest`: walk the lefts in order; the nearest unclaimed acceptable right pairs. Two rights
 *    equally near are REPORTED as ambiguous and the left stays unpaired — unless `twins` says the
 *    two cannot be told apart (identical records), in which case the earlier one in input order
 *    pairs. Never a guess.
 *  - `nearest_global`: every acceptable pair, nearest first (`tieBreak` then input order), claimed
 *    greedily. It is the strategy of a pool where same-amount peers must not strand each other; a
 *    tie at the top distance is paired in the declared order and counted in `tied`, so the caller
 *    can report how often the order decided. This is today's rule of the matchers that use it,
 *    declared rather than hidden — a candidate change for the flow model (F9 step 3).
 *
 * Pure: no database, no clock. Records are compared by identity (the same object), so a list may
 * hold equal-looking records.
 */

export type PairStrategy = "first" | "unique" | "nearest" | "nearest_global";

export type PairRule<L, R> = {
  strategy: PairStrategy;
  /** Whether the pair is acceptable at all (window, money, accounts, rejections). */
  accepts: (left: L, right: R) => boolean;
  /** How far apart an acceptable pair is; smaller is nearer. Defaults to 0 (no preference). */
  distance?: (left: L, right: R) => number;
  /** `nearest`: whether two equally near rights are identical twins that pair in order. */
  twins?: (a: R, b: R) => boolean;
  /** `nearest_global`: order among pairs at the same distance (negative: `a` first). */
  tieBreak?: (a: { left: L; right: R }, b: { left: L; right: R }) => number;
};

export type PairResult<L, R> = {
  pairs: { left: L; right: R; distance: number }[];
  /** Lefts that could not be paired because several rights fit equally well (never guessed). */
  ambiguous: { left: L; rights: R[] }[];
  /** Lefts with no acceptable unclaimed right. */
  unpaired: L[];
  /** Rights nobody claimed. */
  unclaimed: R[];
  /** `nearest_global`: pairs claimed while another acceptable pair sat at the same distance. */
  tied: number;
};

export function pairOneToOne<L, R>(lefts: readonly L[], rights: readonly R[], rule: PairRule<L, R>): PairResult<L, R> {
  const distance = rule.distance ?? (() => 0);
  const claimed = new Set<R>();
  const pairs: PairResult<L, R>["pairs"] = [];
  const ambiguous: PairResult<L, R>["ambiguous"] = [];
  const paired = new Set<L>();
  let tied = 0;

  if (rule.strategy === "nearest_global") {
    const all: { left: L; right: R; d: number; order: number }[] = [];
    let order = 0;
    for (const left of lefts) {
      for (const right of rights) {
        if (!rule.accepts(left, right)) continue;
        all.push({ left, right, d: distance(left, right), order: order++ });
      }
    }
    all.sort((a, b) => a.d - b.d || (rule.tieBreak ? rule.tieBreak(a, b) : 0) || a.order - b.order);
    for (let i = 0; i < all.length; i++) {
      const c = all[i]!;
      if (paired.has(c.left) || claimed.has(c.right)) continue;
      // A later pair at the same distance that wanted the same left or right: the order decided.
      for (let j = i + 1; j < all.length && all[j]!.d === c.d; j++) {
        const o = all[j]!;
        if ((o.left === c.left || o.right === c.right) && !paired.has(o.left) && !claimed.has(o.right)) {
          tied++;
          break;
        }
      }
      paired.add(c.left);
      claimed.add(c.right);
      pairs.push({ left: c.left, right: c.right, distance: c.d });
    }
  } else {
    for (const left of lefts) {
      const fits = rights.filter((r) => !claimed.has(r) && rule.accepts(left, r));
      if (fits.length === 0) continue;
      if (rule.strategy === "first") {
        claimed.add(fits[0]!);
        paired.add(left);
        pairs.push({ left, right: fits[0]!, distance: distance(left, fits[0]!) });
        continue;
      }
      if (rule.strategy === "unique") {
        if (fits.length > 1) {
          ambiguous.push({ left, rights: fits });
          continue;
        }
        claimed.add(fits[0]!);
        paired.add(left);
        pairs.push({ left, right: fits[0]!, distance: distance(left, fits[0]!) });
        continue;
      }
      const ranked = fits.map((r) => ({ r, d: distance(left, r) })).sort((a, b) => a.d - b.d);
      const nearest = ranked.filter((x) => x.d === ranked[0]!.d);
      if (nearest.length > 1 && !nearest.every((x) => rule.twins?.(nearest[0]!.r, x.r))) {
        ambiguous.push({ left, rights: nearest.map((x) => x.r) });
        continue;
      }
      claimed.add(nearest[0]!.r);
      paired.add(left);
      pairs.push({ left, right: nearest[0]!.r, distance: nearest[0]!.d });
    }
  }
  const ambiguousLefts = new Set(ambiguous.map((a) => a.left));
  return {
    pairs,
    ambiguous,
    unpaired: lefts.filter((l) => !paired.has(l) && !ambiguousLefts.has(l)),
    unclaimed: rights.filter((r) => !claimed.has(r)),
    tied,
  };
}

/**
 * The candidates ordered nearest first (stable: equal distances keep input order), plus whether
 * the two nearest are equally near — the building block of matchers that pair a record to
 * evidence without removing the evidence (a payment mirror reports a shared piece of evidence
 * itself).
 */
export function rankByDistance<T>(
  candidates: readonly T[],
  distance: (c: T) => number
): { ranked: { item: T; d: number }[]; tiedAtTop: boolean } {
  const ranked = candidates.map((item) => ({ item, d: distance(item) })).sort((a, b) => a.d - b.d);
  return { ranked, tiedAtTop: ranked.length > 1 && ranked[0]!.d === ranked[1]!.d };
}
