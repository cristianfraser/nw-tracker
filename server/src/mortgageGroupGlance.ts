/**
 * The mortgage group page (`GET /api/portfolio-groups/:slug/mortgage-glance`): every loan of the
 * group read from its own account page block (`depto_glance` of the account detail bundle,
 * `deptoGlance.ts`), so a loan's figures here are the loan page's, then summed.
 *
 * Every sum is in the request's display unit; a loan's own figures stay in its loan currency
 * beside it. Conversions (the loan side, `debt`):
 * - today's balance: the loan page's own value in the unit (`header.hero`, or the loan-currency
 *   figure when the unit is the loan currency);
 * - the chart: each loan's balance (its ledger steps, carried between payments) converted on each
 *   chart date — the payment dates of every loan, the month-ends between them and today — so a
 *   loan indexed to the UF drifts with it between payments;
 * - the rail's original / paid / prepaid quantities: at today's rate (what that much debt is
 *   worth today);
 * - the next cuotas: the loan page's figures in the payment currency (the cuota at its due day's
 *   UF), converted into the unit at today's rate;
 * - the financing cost: already in the unit on each loan page, summed per period and per year.
 */
import type {
  DeptoGlanceDto,
  DeptoPaymentBarDto,
  DeptoPrepayBlockDto,
  MortgageGroupPaymentsDto,
  MortgageGroupChartDto,
  MortgageGroupGlanceDto,
  MortgageGroupLoanDto,
  MortgageGroupNextDto,
} from "nw-tracker-contracts/dto";
import { addCalendarMonths, monthEndUtcYmd } from "nw-tracker-contracts";
import { cachedAccountDetailBundle } from "./accountDetailBundle.js";
import { getAccountColorRgb } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import type { TsUnit } from "./rates.js";
import { convertValue } from "./valueConvert.js";
import { getBenchmark } from "./benchmarkLevels.js";
import { deptoPrepayBlock } from "./deptoGlance.js";
import { computeMortgageGroupPrepaymentComparison } from "./mortgagePrepaymentComparison.js";

/** The one group the page serves (the Pasivos › mortgage node). */
export const MORTGAGE_GROUP_SLUG = "liabilities_mortgage";

type MortgageGlance = Extract<DeptoGlanceDto, { kind: "mortgage" }>;

function inUnit(qty: number, from: string, unit: TsUnit, ymd: string, what: string): number {
  const out = convertValue(qty, from, unit, ymd, "debt");
  if (out == null || !Number.isFinite(out)) throw new Error(`mortgage group: no ${from}→${unit} rate on ${ymd} for ${what}`);
  return out;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** The loan's balance in its currency on `ymd`: the last ledger step on or before it, null before the loan. */
function balanceOn(glance: MortgageGlance, ymd: string): number | null {
  let out: number | null = null;
  for (const p of glance.mortgage.balance.points) {
    if (p.date > ymd) break;
    out = p.balance_loan;
  }
  return out;
}

/** Payment dates of every loan, each month-end between the first and today, and today. */
function chartDates(glances: readonly MortgageGlance[], asOf: string): string[] {
  const dates = new Set<string>([asOf]);
  let first: string | null = null;
  for (const g of glances) {
    for (const p of g.mortgage.balance.points) {
      if (p.date <= asOf) dates.add(p.date);
      if (first == null || p.date < first) first = p.date;
    }
  }
  if (first != null) {
    for (let ym = first.slice(0, 7); monthEndUtcYmd(ym) < asOf; ym = addCalendarMonths(ym, 1)) {
      dates.add(monthEndUtcYmd(ym));
    }
  }
  return [...dates].sort();
}

function buildChart(glances: readonly { accountId: number; glance: MortgageGlance }[], unit: TsUnit, asOf: string): MortgageGroupChartDto {
  const dates = chartDates(
    glances.map((g) => g.glance),
    asOf
  );
  const series = glances.map(({ accountId, glance }) => ({
    account_id: accountId,
    values: dates.map((d) => {
      const bal = balanceOn(glance, d);
      return bal == null ? null : inUnit(bal, glance.loan_currency, unit, d, `account ${accountId} balance`);
    }),
  }));
  const prepagos = glances.flatMap(({ accountId, glance }) =>
    glance.mortgage.balance.points
      .filter((p) => p.kind === "prepago" && p.step_loan != null && p.date <= asOf)
      .map((p) => ({
        date: p.date,
        account_id: accountId,
        step: inUnit(p.step_loan!, glance.loan_currency, unit, p.date, `account ${accountId} prepago`),
      }))
  );
  return { dates, series, prepagos };
}

function loanDto(accountId: number, name: string, glance: MortgageGlance, unit: TsUnit, asOf: string): MortgageGroupLoanDto {
  const { balance, projection } = glance.mortgage;
  const next = glance.mortgage.payments.next;
  return {
    account_id: accountId,
    name,
    color_rgb: getAccountColorRgb(accountId),
    loan_currency: glance.loan_currency,
    payment_currency: glance.payment_currency,
    balance_loan: glance.header.hero_loan,
    balance: glance.header.hero ?? glance.header.hero_loan,
    original_loan: balance.original_loan,
    paid_loan: balance.paid_loan,
    paid_share: balance.paid_share,
    next:
      next == null
        ? null
        : {
            date: next.date,
            min_loan: next.min_loan,
            max_loan: next.max_loan,
            min: inUnit(next.min_pay, glance.payment_currency, unit, asOf, `account ${accountId} next cuota`),
          },
    annual_rate: projection == null ? null : (1 + projection.monthly_rate) ** 12 - 1,
    payoff: projection == null ? null : { date: projection.usual.end_date, cuotas: projection.usual.cuotas },
  };
}

/** A bar drawn on one loan's scale, redrawn on the merged list's (larger or equal) scale. */
function rescaleBar(bar: DeptoPaymentBarDto, from: number, to: number, paidLoan: number): DeptoPaymentBarDto {
  if (bar.segments.length === 1 && bar.segments[0]!.part === "prepago") {
    return { segments: [{ part: "prepago", share: Math.min(1, paidLoan / to) }], clipped: paidLoan > to };
  }
  return { segments: bar.segments.map((s) => ({ part: s.part, share: (s.share * from) / to })), clipped: bar.clipped };
}

/** True when the loans differ in loan or payment currency: their payments lists are not one list. */
function paymentsCurrenciesDiffer(loans: readonly { glance: MortgageGlance }[]): boolean {
  return loans.some(
    (l) => l.glance.loan_currency !== loans[0]!.glance.loan_currency || l.glance.payment_currency !== loans[0]!.glance.payment_currency
  );
}

/**
 * The loan pages' payments lists as one (`MortgageGroupPaymentsDto`): every row and next cuota is
 * its loan page's, keyed by account, on the largest scale; the Σ row adds the loans' Σ rows. The
 * loans must share their loan and payment currencies (the list's figures are in them).
 */
function mergedPayments(loans: readonly { accountId: number; name: string; glance: MortgageGlance }[]): MortgageGroupPaymentsDto | null {
  if (loans.length === 0) return null;
  if (paymentsCurrenciesDiffer(loans)) {
    throw new Error(
      `mortgage group payments: the loans are in ${[...new Set(loans.map((l) => `${l.glance.loan_currency}/${l.glance.payment_currency}`))].join(", ")}`
    );
  }
  const loanCurrency = loans[0]!.glance.loan_currency;
  const paymentCurrency = loans[0]!.glance.payment_currency;
  const several = loans.length > 1;
  const tag = (l: (typeof loans)[number]) => (several ? { account_id: l.accountId, name: l.name, color_rgb: getAccountColorRgb(l.accountId) } : null);
  const scale = Math.max(...loans.map((l) => l.glance.mortgage.payments.bar_scale_loan));

  const rows = loans
    .flatMap((l) => {
      const own = l.glance.mortgage.payments.bar_scale_loan;
      return l.glance.mortgage.payments.rows.map((r) => ({
        ...r,
        key: `${l.accountId}:${r.key}`,
        bar: rescaleBar(r.bar, own, scale, r.paid_loan),
        loan: tag(l),
      }));
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const next = loans
    .flatMap((l) => {
      const n = l.glance.mortgage.payments.next;
      if (n == null) return [];
      return [
        {
          ...n,
          min_share: Math.min(1, n.min_loan / scale),
          max_share: n.max_loan != null ? Math.min(1, n.max_loan / scale) : null,
          loan: tag(l),
        },
      ];
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const each = loans.map((l) => l.glance.mortgage.payments.totals);
  const sum = (pick: (t: (typeof each)[number]) => number) => each.reduce((a, t) => a + pick(t), 0);
  const parts = {
    amortization: sum((t) => t.amortization_loan),
    extra: sum((t) => t.extra_loan),
    interest: sum((t) => t.interest_loan),
    insurance: sum((t) => t.insurance_loan),
    charge: sum((t) => t.charge_loan),
  };
  const partsTotal = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    loan_currency: loanCurrency,
    payment_currency: paymentCurrency,
    next,
    totals: {
      first_date: each.map((t) => t.first_date).sort()[0]!,
      count: sum((t) => t.count),
      paid_loan: sum((t) => t.paid_loan),
      paid_pay: sum((t) => t.paid_pay),
      amortization_loan: parts.amortization,
      extra_loan: parts.extra,
      amortization_total_pay: sum((t) => t.amortization_total_pay),
      interest_loan: parts.interest,
      interest_pay: sum((t) => t.interest_pay),
      insurance_loan: parts.insurance,
      insurance_pay: sum((t) => t.insurance_pay),
      charge_loan: parts.charge,
      charge_pay: sum((t) => t.charge_pay),
      bar: {
        segments: (["amortization", "extra", "interest", "insurance", "charge"] as const)
          .filter((p) => parts[p] > 0)
          .map((p) => ({ part: p, share: share(parts[p], partsTotal) })),
        clipped: false,
      },
    },
    rows,
    bar_scale_loan: scale,
    default_benchmark: loans[0]!.glance.mortgage.payments.default_benchmark,
  };
}

/** The group's loan accounts (Pasivos › mortgage); null when the slug is not the mortgage group. */
function mortgageGroupLoanIds(slug: string): number[] | null {
  if (slug !== MORTGAGE_GROUP_SLUG) return null;
  return listLiabilitiesTabAccountRows("mortgage").map((r) => r.account_id);
}

/**
 * `GET /api/portfolio-groups/:slug/mortgage-prepayments`: the merged payments list's
 * prepaid-vs-invested column (rows keyed as the list's, `<account id>:<label>`). Undefined when the
 * slug is not the mortgage group or the benchmark is unknown; null when no loan paid above the minimum.
 */
export function mortgageGroupPrepayBlock(slug: string, benchmarkSlug: string, unit: TsUnit): DeptoPrepayBlockDto | null | undefined {
  const accountIds = mortgageGroupLoanIds(slug);
  const benchmark = getBenchmark(benchmarkSlug);
  if (accountIds == null || !benchmark) return undefined;
  return deptoPrepayBlock(computeMortgageGroupPrepaymentComparison({ accountIds, benchmark, unit }));
}

/** The page payload; null when the slug is not the mortgage group. */
export async function buildMortgageGroupGlance(slug: string, unit: TsUnit): Promise<MortgageGroupGlanceDto | null> {
  if (mortgageGroupLoanIds(slug) == null) return null;
  const asOf = chileCalendarTodayYmd();
  const rows = listLiabilitiesTabAccountRows("mortgage");
  const withLedger: { accountId: number; name: string; glance: MortgageGlance }[] = [];
  const withoutLedger: { account_id: number; name: string }[] = [];
  for (const r of rows) {
    const bundle = await cachedAccountDetailBundle(r.account_id, unit, "monthly");
    if (bundle == null) throw new Error(`mortgage group: account ${r.account_id} has no detail bundle`);
    const g = bundle.depto_glance;
    if (g == null) {
      withoutLedger.push({ account_id: r.account_id, name: r.name });
      continue;
    }
    if (g.kind !== "mortgage") throw new Error(`mortgage group: account ${r.account_id} is a ${g.kind}, not a mortgage`);
    if (g.unit !== unit) throw new Error(`mortgage group: account ${r.account_id}'s glance is in ${g.unit}, not ${unit}`);
    withLedger.push({ accountId: r.account_id, name: r.name, glance: g });
  }

  const loans = withLedger.map(({ accountId, name, glance }) => loanDto(accountId, name, glance, unit, asOf));
  const sum = (f: (g: MortgageGlance, i: number) => number) => withLedger.reduce((a, x, i) => a + f(x.glance, i), 0);
  const today = (g: MortgageGlance, qty: number, what: string) => inUnit(qty, g.loan_currency, unit, asOf, what);
  const todayPay = (g: MortgageGlance, amount: number, what: string) => inUnit(amount, g.payment_currency, unit, asOf, what);

  const balanceTotal = loans.reduce((a, l) => a + l.balance, 0);
  const original = sum((g) => today(g, g.mortgage.balance.original_loan, "original loan"));
  const paid = sum((g) => today(g, g.mortgage.balance.paid_loan, "paid"));
  const prepaid = sum((g) => today(g, g.mortgage.balance.prepaid_loan, "prepaid"));
  const left = sum((g) => today(g, g.mortgage.balance.left_loan, "left"));

  const years = new Map<string, number>();
  for (const { glance } of withLedger) {
    for (const y of glance.mortgage.balance.financing_cost.years) years.set(y.year, (years.get(y.year) ?? 0) + y.cost);
  }
  const days = withLedger.map((x) => x.glance.header.strip.day);
  const paymentsMixed = withLedger.length > 0 && paymentsCurrenciesDiffer(withLedger);

  const nextOnes = withLedger.filter((x) => x.glance.mortgage.payments.next != null);
  let next: MortgageGroupNextDto | null = null;
  if (nextOnes.length > 0) {
    const dates = nextOnes.map((x) => x.glance.mortgage.payments.next!.date).sort();
    const maxes = nextOnes.map((x) => x.glance.mortgage.payments.next!.max_pay);
    next = {
      first_date: dates[0]!,
      last_date: dates[dates.length - 1]!,
      count: nextOnes.length,
      min: nextOnes.reduce((a, x) => a + todayPay(x.glance, x.glance.mortgage.payments.next!.min_pay, "next cuota minimum"), 0),
      max: maxes.some((m) => m == null)
        ? null
        : nextOnes.reduce((a, x) => a + todayPay(x.glance, x.glance.mortgage.payments.next!.max_pay!, "next cuota maximum"), 0),
    };
  }

  return {
    unit,
    as_of: asOf,
    balance: balanceTotal,
    strip: {
      // A loan with no day figure (opened today) leaves the day unknown, never a partial sum.
      day: days.some((d) => d == null) ? null : days.reduce<number>((a, d) => a + d!, 0),
      month: sum((g) => g.header.strip.month),
      year: sum((g) => g.header.strip.year),
      total: sum((g) => g.header.strip.total),
    },
    next,
    loans,
    payments: paymentsMixed ? null : mergedPayments(withLedger),
    payments_mixed_currencies: paymentsMixed,
    loans_without_ledger: withoutLedger,
    total:
      loans.length > 1
        ? { balance: balanceTotal, paid_share: share(paid, original), next_min: next?.min ?? null }
        : null,
    chart: buildChart(withLedger, unit, asOf),
    rail: {
      original,
      paid,
      left,
      paid_share: share(paid, original),
      prepaid,
      cuotas_paid: paid - prepaid,
      financing_cost: {
        total: sum((g) => g.mortgage.balance.financing_cost.total),
        years: [...years.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, cost]) => ({ year, cost })),
      },
    },
  };
}
