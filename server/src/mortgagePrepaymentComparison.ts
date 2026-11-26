import { levelInUnit } from "./benchmarkComparison.js";
import { benchmarkLevelSeries, type BenchmarkRow } from "./benchmarkLevels.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { mortgageLedgerRowDto } from "./mortgageLedgerDto.js";
import { loanMonthlyRate } from "./mortgageLoanRate.js";
import { flowEventInUnit } from "./rates.js";
import { windowIrr } from "./irr.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * The mortgage's prepayments against a benchmark: every peso paid above the minimum cuota is
 * followed to today two ways. Above the minimum is the extra amortization inside a regular payment
 * (`loan_payments.extra_principal`, in the payment's currency) and the WHOLE of a prepago made outside a cuota
 * (`flow_kind = 'prepago_parcial_hipotecario'`), interest included: it has no minimum, so all of it
 * is money that could have been invested instead.
 *
 * - **prepaid** — what it is worth having gone into the mortgage: only the amortization reduced
 *   the loan, so only it stopped accruing the loan's rate and grows at the loan's currency
 *   compounded at THAT loan's own rate (`loanMonthlyRate`, read from its ledger; two loans at
 *   two rates each grow at their own); the interest a prepago carries is worth nothing on this side;
 * - **invested** — what the whole extra would be worth had it gone into the chosen benchmark on
 *   the same day.
 *
 * Δ = invested − prepaid: positive means investing the extra would have come out ahead so far.
 * Before tax on both sides; the insurance that shrinks with the balance is left out.
 */

export type PrepaymentRow = {
  date: string;
  /** The ledger's cuota label: a cuota number, or `prepago N`. */
  cuota: string;
  /** Paid above the minimum cuota (a prepago's whole payment), in the display unit at that day's rate. */
  extra: number;
  prepaid_value: number | null;
  invested_value: number | null;
  delta: number | null;
  /** Δ ÷ prepaid value (a fraction): how much more (or less) investing is worth than prepaying. */
  delta_pct: number | null;
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
  /** Δ ÷ prepaid value (a fraction). */
  delta_pct: number | null;
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

function deltaPct(prepaid: number | null, invested: number | null): number | null {
  return prepaid != null && invested != null && prepaid > 0 ? invested / prepaid - 1 : null;
}

type ExtraPayment = {
  date: string;
  cuota: string;
  /** Paid above the minimum: what could have been invested instead. */
  extra_clp: number;
  /** The part of it that paid down the loan. */
  amortization_clp: number;
};

/** Payments above the minimum on a mortgage account, oldest first. Empty for any other account. */
export function listMortgageExtraPayments(accountId: number): ExtraPayment[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, m.occurred_on AS date, m.amount AS amount, m.flow_kind AS flow_kind,
              d.cuota AS cuota, d.payment_currency AS payment_currency, d.principal AS amortizacion_clp,
              d.extra_principal AS amortizacion_ext_clp, d.interest AS interes_clp,
              d.insurance_fire AS incendio_clp, d.insurance_life AS desgravamen_clp,
              d.prepayment_charge AS prepayment_charge_clp
       FROM loan_payments d JOIN movements m ON m.id = d.movement_id
       WHERE d.leg = 'loan' AND m.account_id = ?
       ORDER BY m.occurred_on, m.id`
    )
    .all(accountId) as {
    movement_id: number;
    date: string;
    amount: number;
    flow_kind: string | null;
    cuota: string;
    payment_currency: string;
    amortizacion_clp: number | null;
    amortizacion_ext_clp: number | null;
    interes_clp: number | null;
    incendio_clp: number | null;
    desgravamen_clp: number | null;
    prepayment_charge_clp: number | null;
  }[];
  const out: ExtraPayment[] = [];
  for (const r of rows) {
    if (r.payment_currency !== "clp") { // convention-ok: a mortgage cuota is paid in pesos (loan_payments)
      throw new Error(`mortgage payment ${r.cuota} (movement ${r.movement_id}): parts in ${r.payment_currency}, expected pesos`);
    }
    const amortization = r.amortizacion_ext_clp ?? 0;
    if (r.flow_kind === "prepago_parcial_hipotecario") {
      // A prepago outside a cuota has no minimum: the whole payment is above it, the bank's
      // prepayment charge included (money that could have been invested, and pays nothing down).
      const paid =
        (r.amortizacion_clp ?? 0) +
        amortization +
        (r.interes_clp ?? 0) +
        (r.incendio_clp ?? 0) +
        (r.desgravamen_clp ?? 0) +
        (r.prepayment_charge_clp ?? 0);
      if (Math.abs(paid - r.amount) > 1) {
        throw new Error(
          `mortgage prepago ${r.cuota} (movement ${r.movement_id}): its parts add up to ${paid}, the payment is ${r.amount}`
        );
      }
      if (!(paid > 0)) continue;
      out.push({ date: r.date, cuota: r.cuota, extra_clp: paid, amortization_clp: amortization });
      continue;
    }
    if (!(amortization > 0)) continue;
    out.push({ date: r.date, cuota: r.cuota, extra_clp: amortization, amortization_clp: amortization });
  }
  return out;
}

/**
 * What a unit of the loan's debt grows into: its currency's index compounded at the loan's own
 * yearly rate, as a level series (the shape of an `index_plus_rate` benchmark).
 */
function loanOwnRateLevel(accountId: number): BenchmarkRow {
  const ledger = deptoLedgerForLoan(accountId).map(mortgageLedgerRowDto);
  const monthly = loanMonthlyRate(ledger);
  if (monthly == null) throw new Error(`prepayment comparison: loan ${accountId} has no regular cuota to read its rate from`);
  const loanCurrency = ledger[0]!.loan_currency;
  if (loanCurrency !== "uf") { // convention-ok: the index series this level is built on is the UF's (benchmarkLevels)
    throw new Error(`prepayment comparison: loan ${accountId} is in ${loanCurrency}, only a UF loan has an index series`);
  }
  return {
    slug: `loan:${accountId}`,
    kind: "index_plus_rate",
    label_i18n_key: null,
    ticker: null,
    withholding_pct: null,
    series_key: null,
    index_key: "uf",
    rate_pct: ((1 + monthly) ** 12 - 1) * 100,
    portfolio_group_slug: null,
    sort_order: 0,
  };
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
  const prepaidLevel = levelInUnit(benchmarkLevelSeries(loanOwnRateLevel(accountId), todayYmd, now, unit), unit, now);
  const investedLevel = levelInUnit(benchmarkLevelSeries(benchmark, todayYmd, now, unit), unit, now);

  const grow = (level: (ymd: string) => number | null, amount: number, date: string): number | null => {
    const from = level(date);
    const to = level(todayYmd);
    if (from == null || to == null || !(from > 0)) return null;
    return amount * (to / from);
  };

  const rows: PrepaymentRow[] = payments.map((p) => {
    const extra = flowEventInUnit({ occurred_on: p.date, amt: p.extra_clp }, unit);
    const amortization = flowEventInUnit({ occurred_on: p.date, amt: p.amortization_clp }, unit);
    const prepaid = grow(prepaidLevel, amortization, p.date);
    const invested = grow(investedLevel, extra, p.date);
    return {
      date: p.date,
      cuota: p.cuota,
      extra,
      prepaid_value: prepaid,
      invested_value: invested,
      delta: prepaid != null && invested != null ? invested - prepaid : null,
      delta_pct: deltaPct(prepaid, invested),
    };
  });

  return {
    unit,
    account_id: accountId,
    benchmark: { slug: benchmark.slug },
    as_of_date: todayYmd,
    rows,
    totals: prepaymentTotals(rows, todayYmd),
  };
}

/**
 * The Σ row over payments (oldest first). Totals cover the payments the benchmark reaches: one that
 * predates the benchmark's history (your Acciones began after the first prepayments) is listed with
 * no invested value and left out of both sides of the totals, so they still compare like with like.
 */
export function prepaymentTotals(rows: readonly PrepaymentRow[], todayYmd: string): PrepaymentTotals {
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
    covered_payments: covered.length,
    covered_from: covered[0]?.date ?? null,
    extra,
    prepaid_value: prepaidValue,
    invested_value: investedValue,
    delta: prepaidValue != null && investedValue != null ? investedValue - prepaidValue : null,
    delta_pct: deltaPct(prepaidValue, investedValue),
    prepaid_irr_pct: prepaidIrr?.pct ?? null,
    invested_irr_pct: investedIrr?.pct ?? null,
    irr_annualized: (prepaidIrr ?? investedIrr)?.annualized ?? false,
  };
}

/**
 * Several loans as one list (the mortgage group page): each loan's own comparison, its rows keyed
 * `<account id>:<cuota>` and merged by date, the Σ row over all of them by the same rule. Null when
 * no loan has a payment above the minimum.
 */
export function computeMortgageGroupPrepaymentComparison(input: {
  accountIds: readonly number[];
  benchmark: BenchmarkRow;
  unit: TsUnit;
  now?: Date;
}): Omit<MortgagePrepaymentComparison, "account_id"> | null {
  const { accountIds, benchmark, unit } = input;
  const now = input.now ?? new Date();
  const todayYmd = chileWallClockAt(now).ymd;
  const rows: PrepaymentRow[] = [];
  for (const accountId of accountIds) {
    const c = computeMortgagePrepaymentComparison({ accountId, benchmark, unit, now });
    if (c == null) continue;
    rows.push(...c.rows.map((r) => ({ ...r, cuota: `${accountId}:${r.cuota}` })));
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { unit, benchmark: { slug: benchmark.slug }, as_of_date: todayYmd, rows, totals: prepaymentTotals(rows, todayYmd) };
}
