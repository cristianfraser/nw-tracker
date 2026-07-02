/**
 * Synthetic demo-data narrative for the hosted recruiter demo.
 *
 * Design (2026-07): all money flows originate from ONE checking account and ONE credit
 * card master — the same "master moves" model the reconciliation engine expects — so
 * every derived surface (deposits matching, CC billing months, gastos categories,
 * net-worth buckets) is internally consistent by construction. Extra cards can be
 * simulated later by splitting the generated CC lines across 2–3 card accounts.
 *
 * The timeline tells a life story in chapters; each chapter sets the *parameters* the
 * month generator draws from (income, rent, groceries cadence, savings rate), and
 * one-off events (moving costs, vacations, house down payment) are injected on top.
 * Amounts are deliberately parameterized so the whole history can be re-rolled with a
 * different seed / scale and never resembles real data.
 */

/** `YYYY-MM`. */
export type DemoMonth = string;

export type DemoChapterId =
  | "first_job_at_parents"
  | "first_apartment"
  | "pandemic_lockdown"
  | "back_with_parents"
  | "renting_again"
  | "own_house";

export type DemoChapter = {
  id: DemoChapterId;
  /** Inclusive start month. Chapter runs until the next chapter's start. */
  from: DemoMonth;
  /** Net monthly salary landing in checking (CLP). Grows by `salaryAnnualGrowth`. */
  salaryClp: number;
  salaryAnnualGrowth: number;
  /** Fixed monthly outflows from checking (rent/mortgage, bills, fees). */
  fixedExpensesClp: number;
  /** Mean discretionary CC spend per month (groceries, restaurants, shopping). */
  ccSpendMeanClp: number;
  /** Fraction of leftover cash swept to investments/savings each month (0–1). */
  savingsRate: number;
  /** Weight multipliers per gastos category for this chapter (supermarket, fun, …). */
  categoryWeights?: Record<string, number>;
};

export type DemoEventKind =
  | "moving_costs"
  | "vacation_small"
  | "vacation_medium"
  | "vacation_big"
  | "house_down_payment"
  | "bonus";

export type DemoEvent = {
  month: DemoMonth;
  kind: DemoEventKind;
  /** Positive = extra spend (CC unless `viaChecking`), negative = extra income. */
  amountClp: number;
  viaChecking?: boolean;
  /** Big purchases can bill as N cuotas on the card (exercises installment views). */
  cuotas?: number;
  label: string;
};

export type DemoNarrative = {
  /** Deterministic PRNG seed — same seed, same demo DB. */
  seed: number;
  firstMonth: DemoMonth;
  lastMonth: DemoMonth;
  chapters: DemoChapter[];
  events: DemoEvent[];
};

/**
 * Default narrative (mirrors the real arc without any real figure):
 * start working while living with parents → first apartment → May-2020 lockdown dip →
 * big vacation then back with parents → renting again → house purchase, with 1–2
 * vacations per year of varying size throughout.
 */
export const DEFAULT_DEMO_NARRATIVE: DemoNarrative = {
  seed: 20260701,
  firstMonth: "2018-03",
  lastMonth: "2026-06",
  chapters: [
    {
      id: "first_job_at_parents",
      from: "2018-03",
      salaryClp: 900_000,
      salaryAnnualGrowth: 0.08,
      fixedExpensesClp: 80_000,
      ccSpendMeanClp: 150_000,
      savingsRate: 0.55,
      categoryWeights: { fun: 1.4, supermarket: 0.3 },
    },
    {
      id: "first_apartment",
      from: "2019-06",
      salaryClp: 1_250_000,
      salaryAnnualGrowth: 0.07,
      fixedExpensesClp: 520_000,
      ccSpendMeanClp: 320_000,
      savingsRate: 0.2,
      categoryWeights: { supermarket: 1.3, bills: 1.2 },
    },
    {
      id: "pandemic_lockdown",
      from: "2020-04",
      salaryClp: 1_320_000,
      salaryAnnualGrowth: 0.05,
      fixedExpensesClp: 520_000,
      ccSpendMeanClp: 140_000,
      savingsRate: 0.45,
      categoryWeights: { fun: 0.2, supermarket: 1.5, delivery: 1.6 },
    },
    {
      id: "back_with_parents",
      from: "2021-09",
      salaryClp: 1_650_000,
      salaryAnnualGrowth: 0.08,
      fixedExpensesClp: 120_000,
      ccSpendMeanClp: 260_000,
      savingsRate: 0.55,
    },
    {
      id: "renting_again",
      from: "2022-11",
      salaryClp: 2_100_000,
      salaryAnnualGrowth: 0.07,
      fixedExpensesClp: 680_000,
      ccSpendMeanClp: 420_000,
      savingsRate: 0.3,
    },
    {
      id: "own_house",
      from: "2024-08",
      salaryClp: 2_600_000,
      salaryAnnualGrowth: 0.06,
      fixedExpensesClp: 950_000,
      ccSpendMeanClp: 480_000,
      savingsRate: 0.25,
      categoryWeights: { home: 1.5 },
    },
  ],
  events: [
    { month: "2019-06", kind: "moving_costs", amountClp: 450_000, cuotas: 3, label: "Mudanza depto" },
    { month: "2019-12", kind: "vacation_small", amountClp: 380_000, label: "Vacaciones sur" },
    { month: "2021-07", kind: "vacation_big", amountClp: 2_400_000, cuotas: 6, label: "Gran viaje" },
    { month: "2022-02", kind: "vacation_small", amountClp: 420_000, label: "Playa" },
    { month: "2022-11", kind: "moving_costs", amountClp: 380_000, label: "Mudanza arriendo" },
    { month: "2023-07", kind: "vacation_medium", amountClp: 1_100_000, cuotas: 3, label: "Viaje" },
    { month: "2024-01", kind: "vacation_medium", amountClp: 900_000, label: "Verano" },
    { month: "2024-08", kind: "house_down_payment", amountClp: 18_000_000, viaChecking: true, label: "Pie casa" },
    { month: "2024-08", kind: "moving_costs", amountClp: 600_000, cuotas: 6, label: "Mudanza casa" },
    { month: "2025-02", kind: "vacation_small", amountClp: 450_000, label: "Playa" },
    { month: "2025-09", kind: "vacation_big", amountClp: 2_100_000, cuotas: 6, label: "Viaje largo" },
    { month: "2026-01", kind: "vacation_medium", amountClp: 950_000, label: "Verano" },
  ],
};

/** Chapter in effect for a month (chapters sorted by `from`; last one whose from ≤ month). */
export function chapterForMonth(narrative: DemoNarrative, month: DemoMonth): DemoChapter {
  const sorted = [...narrative.chapters].sort((a, b) => a.from.localeCompare(b.from));
  let current = sorted[0];
  if (!current) throw new Error("demo narrative needs at least one chapter");
  for (const ch of sorted) {
    if (ch.from <= month) current = ch;
  }
  return current;
}

/** Deterministic mulberry32 PRNG — same narrative seed ⇒ identical demo DB. */
export function demoRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
