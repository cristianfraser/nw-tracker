/**
 * The pending-listing pairing runs on the shared `pairOneToOne` helper (`mutual_unique`) with the
 * recurring matcher's own pattern and UF tests. This file keeps the loop it replaced — «the
 * pre-wave-7 rule» — as a reference and feeds both the same randomised card lines: identical
 * pairs, identical ambiguity reports.
 */
import { describe, expect, it } from "vitest";
import { addDaysIso, dayWithinWindow, daysBetweenIso } from "nw-tracker-contracts";
import { pairRecurringPendingLines, type RecurringPendingLine } from "./ccRecurringPendingLines.js";
import { recurringPatternIndex, ufAmountFits, type RecurringEntry } from "./recurringPaymentMatch.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { seededRandom } from "./matching/seededRandom.js";

/** The pre-wave-7 rule: the loop `planRecurringPendingReplacement` carried for one entry. */
function preWave7Pairing(entry: RecurringEntry, lines: readonly RecurringPendingLine[], ufOn: (ymd: string) => number) {
  const pairs: [number, number][] = [];
  const ambiguous: string[] = [];
  const named = lines.map((l) => ({ l, k: recurringPatternIndex(entry, l.merchant) })).filter((x) => x.k >= 0);
  const postedFor = new Map<number, RecurringPendingLine[]>();
  const pendingFor = new Map<number, number>();
  for (const p of named) {
    if (p.l.bucket !== 1) continue;
    const later = named.filter((s) => {
      if (s.l.id === p.l.id || s.k === p.k || Math.round(s.l.amount_clp) !== Math.round(p.l.amount_clp)) return false;
      return dayWithinWindow(p.l.iso, s.l.iso, { daysBefore: 0, daysAfter: 7 }) && ufAmountFits(entry, Math.round(s.l.amount_clp), s.l.iso, ufOn, 0);
    });
    if (later.length === 0) continue;
    postedFor.set(p.l.id, later.map((s) => s.l));
    for (const s of later) pendingFor.set(s.l.id, (pendingFor.get(s.l.id) ?? 0) + 1);
  }
  for (const [pendingId, posted] of postedFor) {
    const pending = lines.find((l) => l.id === pendingId)!;
    if (posted.length !== 1 || pendingFor.get(posted[0]!.id) !== 1) {
      ambiguous.push(`${entry.name}: ${pending.iso} ${pending.merchant} ${pending.amount_clp} fits ${posted.length} posted line(s)`);
      continue;
    }
    pairs.push([pending.id, posted[0]!.id]);
  }
  return { pairs, ambiguous };
}

const DAY0 = "2031-08-01";
const ufOn = (ymd: string) => 40000 + 4 * daysBetweenIso(DAY0, ymd);
const entry: RecurringEntry = {
  id: 1,
  name: "Seguro ficticio",
  detail: null,
  manual: false,
  frequency: "monthly",
  due_month: null,
  due_day: 5,
  amount: 2,
  currency: "uf",
  patterns: ["CONVENIO FICTICIO", "SEGURO FICTICIO", "ASEGURADORA FICTICIA"],
  match_days_before: 14,
  match_days_after: 7,
  amount_tolerance_pct: 1,
  created_at: "2031-01-01 00:00:00",
};
const MERCHANTS = ["CONVENIO FICTICIO P.A.T.", "SEGURO FICTICIO AUTO", "Aseguradora Fictícia", "CONVENIO FICTICIO", "PANADERIA", null];
// Around 2 UF (80.000–80.100 across the fortnight): inside the 1 % tolerance, at its edge, outside it.
const AMOUNTS = [80000, 80040, 80040.3, 80800, 80900, 79250, 79150, 50000];

describe("recurring pending listings: pairOneToOne reproduces the pre-wave-7 rule", () => {
  it("the window is still the pending day to seven days later", () => {
    expect(MATCH_WINDOWS.recurring_pending).toMatchObject({ daysBefore: 0, daysAfter: 7 });
  });

  it("800 random card ledgers: same pairs, same ambiguity reports", () => {
    const r = seededRandom(310501);
    let paired = 0;
    let reported = 0;
    for (let n = 0; n < 800; n++) {
      const lines: RecurringPendingLine[] = [];
      for (let i = r.int(0, 8); i > 0; i--) {
        const twin = lines.length > 0 && r.chance(0.55) ? r.pick(lines) : null;
        lines.push({
          id: 900 + lines.length,
          merchant: r.pick(MERCHANTS),
          // A twin keeps the pesos (the rule's first test) and lands 0…9 days after: on the day,
          // on the window's last day (7), past it (8, 9).
          amount_clp: twin ? twin.amount_clp : r.pick(AMOUNTS),
          iso: twin ? addDaysIso(twin.iso, r.int(0, 9)) : addDaysIso(DAY0, r.int(0, 6)),
          bucket: r.chance(0.6) ? 1 : 0,
        });
      }
      const want = preWave7Pairing(entry, lines, ufOn);
      const got = pairRecurringPendingLines(entry, lines, ufOn);
      expect(got.pairs.map((x) => [x.pending.id, x.posted.id]), `case ${n}`).toEqual(want.pairs);
      expect(
        got.ambiguous.map((a) => `${entry.name}: ${a.pending.iso} ${a.pending.merchant} ${a.pending.amount_clp} fits ${a.posted.length} posted line(s)`),
        `case ${n}`
      ).toEqual(want.ambiguous);
      paired += want.pairs.length;
      reported += want.ambiguous.length;
    }
    expect(paired).toBeGreaterThan(50);
    expect(reported).toBeGreaterThan(50);
  });
});
