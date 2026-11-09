/**
 * The matcher behind the report-first proposal script (`propose-card-reimbursements.ts`): pairs an
 * additional cardholder's checking credits with the charges they pay back. Script only — nothing
 * on a request path reads it.
 */
export type ReimbursementChargeInput = {
  id: number;
  /** ISO purchase date. */
  date: string;
  amount_clp: number;
  merchant: string | null;
};

export type ReimbursementCreditInput = {
  movement_id: number;
  /** ISO date the wire arrived. */
  date: string;
  amount_clp: number;
};

export type ReimbursementMatchKind =
  /** The oldest unpaid charges up to the credit's date add up to it exactly. */
  | "exact_fifo"
  /** A set of unpaid charges from the preceding window adds up to it exactly. */
  | "exact_window"
  /** No exact set: applied to the oldest unpaid charges (partially if need be). */
  | "unmatched";

export type ReimbursementMatch = {
  credit: ReimbursementCreditInput;
  kind: ReimbursementMatchKind;
  /** Charges the credit paid in full (exact kinds) or touched (unmatched, FIFO). */
  charge_ids: number[];
  /** Unpaid charges dated on/before the credit, before applying it. */
  outstanding_before_clp: number;
  /** Unmatched: the credit minus the nearest FIFO prefix sum (positive = paid more). */
  closest_fifo_delta_clp: number | null;
};

export type ReimbursementMatchResult = {
  matches: ReimbursementMatch[];
  /** Charges still (partly) unpaid after every credit: id → remaining CLP. */
  unpaid: Map<number, number>;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Indices (into `amounts`) of a subset summing exactly to `target`, or null. */
function exactSubset(amounts: readonly number[], target: number): number[] | null {
  if (target <= 0) return null;
  const reached = new Map<number, { prev: number; idx: number }>();
  reached.set(0, { prev: -1, idx: -1 });
  for (let i = 0; i < amounts.length; i++) {
    const a = amounts[i]!;
    if (a <= 0) continue;
    for (const sum of [...reached.keys()]) {
      const next = sum + a;
      if (next > target || reached.has(next)) continue;
      reached.set(next, { prev: sum, idx: i });
      if (next === target) {
        const out: number[] = [];
        let cur = next;
        while (cur !== 0) {
          const step = reached.get(cur)!;
          out.push(step.idx);
          cur = step.prev;
        }
        return out.reverse();
      }
    }
  }
  return null;
}

/**
 * Pairs each reimbursement with the additional-card charges it paid, oldest first. Exact matches
 * are tried FIFO first (the oldest unpaid charges), then as any set of fully-unpaid charges from
 * the `windowDays` before the credit (the most recent `maxWindowCharges` of them); a credit with
 * no exact set pays the oldest charges FIFO, partially if need be, so the running balance stays
 * right either way.
 */
export function matchCardReimbursements(
  charges: readonly ReimbursementChargeInput[],
  credits: readonly ReimbursementCreditInput[],
  opts: { windowDays: number; maxWindowCharges: number }
): ReimbursementMatchResult {
  const sortedCharges = [...charges].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id
  );
  const sortedCredits = [...credits].sort(
    (a, b) => a.date.localeCompare(b.date) || a.movement_id - b.movement_id
  );
  const remaining = new Map<number, number>(sortedCharges.map((c) => [c.id, c.amount_clp]));
  const matches: ReimbursementMatch[] = [];

  for (const credit of sortedCredits) {
    if (!(credit.amount_clp > 0)) {
      throw new Error(`reimbursement ${credit.movement_id} must be a positive credit`);
    }
    const open = sortedCharges.filter(
      (c) => c.date <= credit.date && (remaining.get(c.id) ?? 0) > 0
    );
    const outstanding = open.reduce((s, c) => s + remaining.get(c.id)!, 0);

    let fifo: number[] | null = null;
    let running = 0;
    let closestDelta: number = credit.amount_clp;
    for (let i = 0; i < open.length; i++) {
      running += remaining.get(open[i]!.id)!;
      const delta = credit.amount_clp - running;
      if (Math.abs(delta) < Math.abs(closestDelta)) closestDelta = delta;
      if (running === credit.amount_clp) {
        fifo = open.slice(0, i + 1).map((c) => c.id);
        break;
      }
      if (running > credit.amount_clp) break;
    }
    if (fifo) {
      for (const id of fifo) remaining.set(id, 0);
      matches.push({
        credit,
        kind: "exact_fifo",
        charge_ids: fifo,
        outstanding_before_clp: outstanding,
        closest_fifo_delta_clp: null,
      });
      continue;
    }

    const windowStart = addDaysIso(credit.date, -opts.windowDays);
    const windowCharges = open
      .filter((c) => c.date >= windowStart && remaining.get(c.id) === c.amount_clp)
      .slice(-opts.maxWindowCharges);
    const subset = exactSubset(
      windowCharges.map((c) => c.amount_clp),
      credit.amount_clp
    );
    if (subset) {
      const ids = subset.map((i) => windowCharges[i]!.id);
      for (const id of ids) remaining.set(id, 0);
      matches.push({
        credit,
        kind: "exact_window",
        charge_ids: ids,
        outstanding_before_clp: outstanding,
        closest_fifo_delta_clp: null,
      });
      continue;
    }

    let left = credit.amount_clp;
    const touched: number[] = [];
    for (const c of open) {
      if (left <= 0) break;
      const r = remaining.get(c.id)!;
      const pay = Math.min(r, left);
      remaining.set(c.id, r - pay);
      left -= pay;
      touched.push(c.id);
    }
    matches.push({
      credit,
      kind: "unmatched",
      charge_ids: touched,
      outstanding_before_clp: outstanding,
      closest_fifo_delta_clp: closestDelta,
    });
  }

  const unpaid = new Map<number, number>();
  for (const [id, r] of remaining) if (r !== 0) unpaid.set(id, r);
  return { matches, unpaid };
}
