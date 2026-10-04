import { levelInUnit } from "./benchmarkComparison.js";
import { benchmarkLevelSeries, getBenchmark, type BenchmarkRow } from "./benchmarkLevels.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { flowEventInUnit } from "./flowsDeposits.js";
import { windowIrr } from "./irr.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * The mortgage's prepayments against a benchmark: every peso paid above the minimum cuota
 * (`depto_payments.amortizacion_ext_clp` — the `prepago` rows and the extra inside each regular
 * payment) is followed to today two ways:
 *
 * - **prepaid** — what it is worth having gone into the mortgage: it stopped accruing the loan's
 *   rate, so it grows at the `mortgage` benchmark (UF + the loan rate);
 * - **invested** — what it would be worth had it gone into the chosen benchmark on the same day.
 *
 * Δ = invested − prepaid: positive means investing the extra would have come out ahead so far.
 * Before tax on both sides; the insurance that shrinks with the balance is left out.
 */

export type PrepaymentRow = {
  date: string;
  /** The ledger's cuota label: a cuota number, or `prepago N`. */
  cuota: string;
  /** Paid above the minimum cuota, in the display unit at that day's rate. */
  extra: number;
  prepaid_value: number | null;
  invested_value: number | null;
  delta: number | null;
};

export type PrepaymentTotals = {
  /** Payments the totals include: those the benchmark's history reaches (all of them, usually). */
  covered_payments: number;
  covered_from: string | null;
  /** Σ extra over the covered payments. */
  extra: number;
  prepaid_value: number | null;
  invested_value: number | null;
  delta: number | null;
  /** Each side's internal rate of return on the extra payments; annualized when `irr_annualized`. */
  prepaid_irr_pct: number | null;
  invested_irr_pct: number | null;
  irr_annualized: boolean;
};

export type MortgagePrepaymentComparison = {
  unit: TsUnit;
  account_id: number;
  benchmark: { slug: string };
  as_of_date: string;
  rows: PrepaymentRow[];
  totals: PrepaymentTotals;
};

type ExtraPayment = { date: string; cuota: string; extra_clp: number };

/** Payments above the minimum on a mortgage account, oldest first. Empty for any other account. */
export function listMortgageExtraPayments(accountId: number): ExtraPayment[] {
  const rows = db
    .prepare(
      `SELECT m.occurred_on AS date, d.cuota AS cuota, d.amortizacion_ext_clp AS extra_clp
       FROM depto_payments d JOIN movements m ON m.id = d.movement_id
       WHERE d.kind = 'mortgage' AND m.account_id = ?
       ORDER BY m.occurred_on, m.id`
    )
    .all(accountId) as { date: string; cuota: string; extra_clp: number | null }[];
  const out: ExtraPayment[] = [];
  for (const r of rows) {
    if (r.extra_clp == null || !(r.extra_clp > 0)) continue;
    out.push({ date: r.date, cuota: r.cuota, extra_clp: r.extra_clp });
  }
  return out;
}

export function computeMortgagePrepaymentComparison(input: {
  accountId: number;
  benchmark: BenchmarkRow;
  unit: TsUnit;
  now?: Date;
}): MortgagePrepaymentComparison | null {
  const { accountId, benchmark, unit } = input;
  const now = input.now ?? new Date();
  const payments = listMortgageExtraPayments(accountId);
  if (payments.length === 0) return null;

  const todayYmd = chileWallClockAt(now).ymd;
  const mortgage = getBenchmark("mortgage");
  if (!mortgage) throw new Error("benchmarks: no `mortgage` row");
  const prepaidLevel = levelInUnit(benchmarkLevelSeries(mortgage, todayYmd, now, unit), unit, now);
  const investedLevel = levelInUnit(benchmarkLevelSeries(benchmark, todayYmd, now, unit), unit, now);

  const grow = (level: (ymd: string) => number | null, amount: number, date: string): number | null => {
    const from = level(date);
    const to = level(todayYmd);
    if (from == null || to == null || !(from > 0)) return null;
    return amount * (to / from);
  };

  const rows: PrepaymentRow[] = payments.map((p) => {
    const extra = flowEventInUnit({ occurred_on: p.date, amt: p.extra_clp }, unit);
    const prepaid = grow(prepaidLevel, extra, p.date);
    const invested = grow(investedLevel, extra, p.date);
    return {
      date: p.date,
      cuota: p.cuota,
      extra,
      prepaid_value: prepaid,
      invested_value: invested,
      delta: prepaid != null && invested != null ? invested - prepaid : null,
    };
  });

  // Totals cover the payments the benchmark reaches: one that predates the benchmark's history
  // (your Acciones began after the first prepayments) is listed with no invested value and left
  // out of both sides of the totals, so they still compare like with like.
  const covered = rows.filter((r) => r.prepaid_value != null && r.invested_value != null);
  const sum = (pick: (r: PrepaymentRow) => number): number =>
    covered.reduce((total, r) => total + pick(r), 0);
  const extra = sum((r) => r.extra);
  const prepaidValue = covered.length ? sum((r) => r.prepaid_value!) : null;
  const investedValue = covered.length ? sum((r) => r.invested_value!) : null;
  // The window opens the day before the first covered payment, so that payment is inside it.
  const irr = (value: number | null) =>
    value == null
      ? null
      : windowIrr(
          0,
          chileCalendarAddDays(covered[0]!.date, -1),
          todayYmd,
          covered.map((r) => ({ ymd: r.date, amount: r.extra })),
          value
        );
  const prepaidIrr = irr(prepaidValue);
  const investedIrr = irr(investedValue);

  return {
    unit,
    account_id: accountId,
    benchmark: { slug: benchmark.slug },
    as_of_date: todayYmd,
    rows,
    totals: {
      covered_payments: covered.length,
      covered_from: covered[0]?.date ?? null,
      extra,
      prepaid_value: prepaidValue,
      invested_value: investedValue,
      delta: prepaidValue != null && investedValue != null ? investedValue - prepaidValue : null,
      prepaid_irr_pct: prepaidIrr?.pct ?? null,
      invested_irr_pct: investedIrr?.pct ?? null,
      irr_annualized: (prepaidIrr ?? investedIrr)?.annualized ?? false,
    },
  };
}
