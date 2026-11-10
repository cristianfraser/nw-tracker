/**
 * Schedule B (Interest and Ordinary Dividends), from the year's interest and dividends already in
 * dollars (`facts.ts` converts them at each item's own day, `fx.ts`). Pure: items in, lines out.
 *
 *   Part I    line 1 one row per payer (dollars, rounded per row); 2 = Σ 1; 3 excludable savings-bond
 *             interest (0, not modelled); 4 = 2 − 3 → Form 1040 line 2b
 *   Part II   line 5 one row per payer; 6 = Σ 5 → 1040 line 3b; the qualified part → 1040 line 3a
 *   Part III  7a «at any time during the year, did you have … a financial account … in a foreign
 *             country?» — true when the year shows one (the FBAR / Form 8938 figures ride beside it)
 *
 * **Qualified dividends** (§1(h)(11)): a dividend is qualified when the instrument is a US
 * corporation's share or a US-listed fund that is not a PFIC (the caller decides from the registry,
 * `facts.ts`); a PFIC's distributions are never qualified (Pub. 550: «not a qualified foreign
 * corporation if it is a passive foreign investment company»). The holding-period test — «more than
 * 60 days during the 121-day period that begins 60 days before the ex-dividend date» (Pub. 550) — is
 * NOT applied: no ex-dates are stored ({@link SCHEDULE_B_HOLDING_PERIOD_TESTED} = false, stated on the
 * return).
 */

/** The qualified-dividend holding-period test is not applied (no ex-dividend dates on file). */
export const SCHEDULE_B_HOLDING_PERIOD_TESTED = false;

export type ScheduleBInterestItem = { payer: string; date: string; movementId: number; usd: number };

export type ScheduleBDividendItem = {
  payer: string;
  date: string;
  movementId: number;
  /** The gross dividend (before any tax withheld), dollars. */
  usd: number;
  qualified: boolean;
};

export type ScheduleBPayerRow = { payer: string; items: number; usd: number };

export type ScheduleB = {
  interestRows: ScheduleBPayerRow[];
  /** Line 2 = line 4 (no excludable interest). */
  line2: number;
  line4: number;
  dividendRows: ScheduleBPayerRow[];
  line6: number;
  /** Form 1040 line 3a (≤ line 6). */
  qualifiedDividends: number;
  /** Part III line 7a. */
  foreignAccount: boolean;
};

function byPayer<T extends { payer: string; usd: number }>(items: readonly T[]): ScheduleBPayerRow[] {
  const m = new Map<string, { items: number; usd: number }>();
  for (const i of items) {
    if (!Number.isFinite(i.usd)) throw new Error(`Schedule B: ${i.payer} amount ${i.usd}`);
    const r = m.get(i.payer) ?? { items: 0, usd: 0 };
    r.items += 1;
    r.usd += i.usd;
    m.set(i.payer, r);
  }
  return [...m.entries()]
    .map(([payer, r]) => ({ payer, items: r.items, usd: Math.round(r.usd) }))
    .sort((a, b) => a.payer.localeCompare(b.payer));
}

export function scheduleB(input: {
  interest: readonly ScheduleBInterestItem[];
  dividends: readonly ScheduleBDividendItem[];
  foreignAccount: boolean;
}): ScheduleB {
  for (const i of input.interest) if (i.usd < 0) throw new Error(`Schedule B: negative interest ${i.usd} (movement ${i.movementId})`);
  for (const d of input.dividends) if (d.usd < 0) throw new Error(`Schedule B: negative dividend ${d.usd} (movement ${d.movementId})`);
  const interestRows = byPayer(input.interest);
  const dividendRows = byPayer(input.dividends);
  const line2 = interestRows.reduce((s, r) => s + r.usd, 0);
  const line6 = dividendRows.reduce((s, r) => s + r.usd, 0);
  const qualifiedRaw = Math.round(input.dividends.filter((d) => d.qualified).reduce((s, d) => s + d.usd, 0));
  return {
    interestRows,
    line2,
    line4: line2,
    dividendRows,
    line6,
    // Per-payer rounding can leave the all-qualified total a dollar above line 6.
    qualifiedDividends: Math.min(qualifiedRaw, line6),
    foreignAccount: input.foreignAccount,
  };
}
