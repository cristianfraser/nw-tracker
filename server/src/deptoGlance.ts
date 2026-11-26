/**
 * The property and mortgage pages (`DeptoGlanceDto`, built with the account detail bundle). Both
 * are views on one ledger — the property's depto ledger (`deptoLedgerFromMovements.ts`), each
 * payment a property leg and a loan leg — so every figure the two pages share comes from the same
 * rows. The client only picks and formats: every total, share, window, cap and projection is here.
 *
 * Currencies are the ledger's roles, never named: `_loan` figures are in the loan's currency, `_pay`
 * in the payment's; every other money figure is in the request's display unit — values converted
 * once at their day's rate (`convertValue`), flows at their own day's flow rate (`convertFlow`).
 *
 * Definitions (documented on the DTO too):
 * - **This month's split** (property): the month's P/L = Δ net equity − the payments. It splits into
 *   the part of the payments that did not become equity (Σ amortization − Σ paid: interest,
 *   insurance, a prepayment charge) and the loan currency's move on the property net of the
 *   balance's own indexation (Δ appraisal value − (Δ balance + amortized)). The two must add up to
 *   the dashboard row's month P/L; anything else throws.
 * - **Cost of living** (property): the bills of the tracked place that names the property, with
 *   the mortgage cuota parts, per bill month and kind (the real-estate expenses builder's slots and
 *   kind order); each part converted at its payment day. The rail's window is the last 12 complete
 *   bill months, ending two months before the current one (a bill sits one month before its charge,
 *   and the charge can post a month late).
 * - **Usual pace** (mortgage): the median amortization (scheduled + extra, loan currency) of the
 *   last five regular cuotas — an odd count, so it is a cuota actually paid.
 * - **Projection** (mortgage): from today's balance at the monthly rate the last regular cuota
 *   paid (its interest ÷ the balance before it), one cuota a month from the next one. The usual
 *   path amortizes the usual pace each cuota; the minimum path pays the annuity that ends at the
 *   loan's full term (the minimum scenario's, `MORTGAGE_MINIMUM_TERM_CUOTAS`), recomputed each
 *   cuota. Interest totals leave insurance out.
 */
import type {
  AccountMortgageLedgerResponse,
  DashboardAccountRow,
  DeptoBalanceBandDto,
  DeptoBalancePointDto,
  DeptoCostBandDto,
  DeptoCostDirection,
  DeptoCostMonthDto,
  DeptoGlanceDto,
  DeptoGlanceHeaderDto,
  DeptoMonthSplitDto,
  DeptoMortgageGlanceDto,
  DeptoMortgageSheetRow,
  DeptoNextCuotaDto,
  DeptoPaymentBarDto,
  DeptoPaymentPart,
  DeptoPaymentRowDto,
  DeptoPaymentTotalsDto,
  DeptoPayoffPathDto,
  DeptoPlMonthDto,
  DeptoPrepayBlockDto,
  DeptoPrepayCellDto,
  DeptoProjectionDto,
  DeptoPropertyGlanceDto,
  DeptoPropertyPlBandDto,
  DeptoPropertyValueBandDto,
  DeptoTermKey,
  DeptoValuePointDto,
  AccountMonthlyPerformanceRow,
} from "nw-tracker-contracts/dto";
import { addCalendarMonths, monthEndUtcYmd, monthKeyFromYmd } from "nw-tracker-contracts";
import { accountBucketKindSlug } from "./accountBucket.js";
import { deptoPropertyIdOfAccount } from "./accountRoles.js";
import {
  DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
  DEPTO_VALOR_CHART_ACCOUNT_ID,
  getAccountValuationTimeseries,
} from "./accountValuationTimeseries.js";
import { getBenchmark } from "./benchmarkLevels.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { isDeptoPieCuota, isDeptoPrepagoCuota } from "./deptoDividendosLedger.js";
import { deptoLedgerForAccount } from "./deptoLedgerFromMovements.js";
import { currencyMinorDigits, currencySmallestCoin } from "./displayUnits.js";
import {
  chartedBillParts,
  REAL_ESTATE_CHART_KINDS,
  realEstateBillSlotsReadOnly,
} from "./flowsRealEstateExpenses.js";
import { computeMortgagePrepaymentComparison, type MortgagePrepaymentComparison } from "./mortgagePrepaymentComparison.js";
import { mortgageLedgerRowDto } from "./mortgageLedgerDto.js";
import { loanMonthlyRate } from "./mortgageLoanRate.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import { MORTGAGE_MINIMUM_TERM_CUOTAS } from "./mortgageScenarioPayments.js";
import { convertFlow, storedPairRate, type TsUnit } from "./rates.js";
import { convertValue } from "./valueConvert.js";

/** The payments list's benchmark until the page asks for another (as «Prepagos vs invertir» did). */
export const DEPTO_DEFAULT_PREPAY_BENCHMARK = "spy";

/** How many regular cuotas the usual pace looks back over (odd: the median is a cuota paid). */
const USUAL_PACE_CUOTAS = 5;

/** A projection longer than this many cuotas is a broken input, not a loan. */
const MAX_PROJECTED_CUOTAS = 1200;

type PerfInput = { monthly: AccountMonthlyPerformanceRow[]; yearly: AccountMonthlyPerformanceRow[] } | null;

export type DeptoGlanceInput = {
  unit: TsUnit;
  /** The bundle's own loan ledger payload (its scenarios and card pairing are the loan's). */
  mortgageLedger: AccountMortgageLedgerResponse;
  /** The account's dashboard row in `unit` (the header strip, today's value). */
  row: Pick<
    DashboardAccountRow,
    "current_value" | "delta_day" | "delta_month" | "delta_year" | "delta_total" | "pct_year" | "pct_total_on_deposits"
  > | null;
  /** The account's monthly performance in `unit`. */
  perf: PerfInput;
};

// ---------------------------------------------------------------------------------------------
// small helpers

/** The smallest «nice» number ≥ x among 1, 1,2, 1,5, 2, 2,5, 3, 4, 5, 6, 8 × 10^k. */
export function niceCeil(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new Error(`niceCeil: ${x} is not a positive number`);
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * mag >= x * (1 - 1e-12)) return m * mag;
  }
  return 10 * mag;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function requireNumber(v: number | null | undefined, what: string): number {
  if (v == null || !Number.isFinite(v)) throw new Error(`depto glance: ${what} is missing`);
  return v;
}

/** `YYYY-MM-DD` one calendar month later, the day kept (cuotas fall on the same day each month). */
function addMonthKeepDay(ymd: string, months: number): string {
  return `${addCalendarMonths(ymd.slice(0, 7), months)}${ymd.slice(7)}`;
}

function valueIn(qty: number, from: string, unit: TsUnit, ymd: string, side: "asset" | "debt", what: string): number {
  const out = convertValue(qty, from, unit, ymd, side);
  if (out == null || !Number.isFinite(out)) throw new Error(`depto glance: no ${from}→${unit} rate on ${ymd} for ${what}`);
  return out;
}

function prepagoOrdinal(label: string): number {
  const m = /^prepago\s*(\d+)$/i.exec(label.trim());
  if (!m) throw new Error(`depto glance: prepago label '${label}' carries no number`);
  return Number(m[1]);
}

// ---------------------------------------------------------------------------------------------
// entry point

/**
 * The page block of a property or mortgage account; null for every other account and for a
 * property whose ledger has no row yet.
 */
export function buildDeptoGlanceForAccount(accountId: number, input: DeptoGlanceInput): DeptoGlanceDto | null {
  const kindSlug = accountBucketKindSlugOf(accountId);
  const kind = kindSlug === "mortgage" ? "mortgage" : kindSlug === "property" || kindSlug === "real_estate" ? "property" : null;
  if (kind == null) return null;
  const propertyId = deptoPropertyIdOfAccount(accountId);
  if (propertyId == null) return null;
  const ledger = deptoLedgerForAccount(accountId).map(mortgageLedgerRowDto);
  if (ledger.length === 0) return null;
  const { unit, row, perf } = input;
  if (row == null) throw new Error(`depto glance: account ${accountId} has no dashboard row`);
  if (perf == null) throw new Error(`depto glance: account ${accountId} has no monthly performance`);

  const loanCurrency = ledger[0]!.loan_currency;
  const paymentCurrency = ledger[0]!.payment_currency;
  for (const r of ledger) {
    if (r.loan_currency !== loanCurrency || r.payment_currency !== paymentCurrency) {
      throw new Error(`depto glance: ledger row ${r.cuota} is in ${r.loan_currency}/${r.payment_currency}, not ${loanCurrency}/${paymentCurrency}`);
    }
  }
  const asOf = chileCalendarTodayYmd();
  const last = ledger[ledger.length - 1]!;
  const currentValue = requireNumber(row.current_value, "today's value");
  const base = { unit, loan_currency: loanCurrency, payment_currency: paymentCurrency, as_of: asOf };

  if (kind === "property") {
    const header: DeptoGlanceHeaderDto = {
      hero_loan: requireNumber(last.valor_neto_loan, "net equity"),
      hero: unit === loanCurrency ? null : currentValue,
      strip: {
        day: row.delta_day ?? null,
        month: requireNumber(row.delta_month, "month P/L"),
        year: requireNumber(row.delta_year, "year P/L"),
        total: requireNumber(row.delta_total, "total P/L"),
        year_pct: row.pct_year ?? null,
        total_pct: row.pct_total_on_deposits ?? null,
      },
    };
    return { ...base, kind, header, property: buildProperty(accountId, propertyId, ledger, input, asOf) };
  }

  const header: DeptoGlanceHeaderDto = {
    hero_loan: requireNumber(last.credito_restante_loan, "loan balance"),
    hero: unit === loanCurrency ? null : currentValue,
    strip: {
      day: row.delta_day ?? null,
      month: requireNumber(row.delta_month, "month financing cost"),
      year: requireNumber(row.delta_year, "year financing cost"),
      total: requireNumber(row.delta_total, "total financing cost"),
      year_pct: null,
      total_pct: null,
    },
  };
  return { ...base, kind, header, mortgage: buildMortgage(accountId, ledger, input, asOf) };
}

function accountBucketKindSlugOf(accountId: number): string | null {
  const r = db
    .prepare(`SELECT g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`)
    .get(accountId) as { slug: string } | undefined;
  return r ? accountBucketKindSlug(r.slug) : null;
}

// ---------------------------------------------------------------------------------------------
// property

function buildProperty(
  accountId: number,
  propertyId: number,
  ledger: readonly DeptoMortgageSheetRow[],
  input: DeptoGlanceInput,
  asOf: string
): DeptoPropertyGlanceDto {
  const { unit, row, perf } = input;
  const points = propertyValuePoints(accountId, unit);
  const value = propertyValueBand(ledger, points, unit, asOf);
  const months = plMonths(perf!.monthly);
  const lastMonth = months[months.length - 1];
  if (!lastMonth || lastMonth.month !== asOf.slice(0, 7)) {
    throw new Error(`depto glance: account ${accountId}'s performance has no row for ${asOf.slice(0, 7)}`);
  }
  const monthPl = requireNumber(row!.delta_month, "month P/L");
  const tol = 2 * currencySmallestCoin(unit);
  if (Math.abs(lastMonth.pl - monthPl) > tol) {
    throw new Error(`depto glance: the month's P/L is ${lastMonth.pl} in the performance rows but ${monthPl} on the dashboard row`);
  }
  const pl: DeptoPropertyPlBandDto = {
    months,
    years: plYears(months, perf!.yearly),
    total: { pl: requireNumber(row!.delta_total, "total P/L"), pct: row!.pct_total_on_deposits ?? null },
    this_month: deptoMonthSplit({
      points,
      ledger,
      unit,
      pl: monthPl,
    }),
  };
  return { value, pl, cost: propertyCostBand(propertyId, unit, asOf), movement_count: accountMovementCount(accountId) };
}

/** Movements on the account, transfer legs included (the folded «movimientos (N)» list). */
function accountMovementCount(accountId: number): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`)
    .get(accountId, accountId, accountId) as { c: number };
  return r.c;
}

/** The property's month-end chart points in `unit` (the last one today), from its valuation series. */
function propertyValuePoints(accountId: number, unit: TsUnit): DeptoValuePointDto[] {
  const ts = getAccountValuationTimeseries(accountId, unit, { granularity: "monthly" });
  if (!ts) throw new Error(`depto glance: account ${accountId} has no valuation series`);
  const lines = ts.accounts.accounts ?? [];
  const own = lines.find((l) => l.account_id === accountId);
  const mortgage = lines.find((l) => l.account_id === DEPTO_HIPOTECA_CHART_ACCOUNT_ID);
  const valor = lines.find((l) => l.account_id === DEPTO_VALOR_CHART_ACCOUNT_ID);
  if (!own?.depositDataKey || !mortgage || !valor) {
    throw new Error(`depto glance: account ${accountId}'s valuation series lacks its equity, deposit, mortgage or value line`);
  }
  const num = (p: Record<string, string | number | null>, key: string, date: string): number => {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`depto glance: ${key} has no value on ${date}`);
    return v;
  };
  return ts.accounts.points
    .filter((p) => typeof p[own.dataKey] === "number")
    .map((p) => {
      const date = String(p.as_of_date);
      return {
        date,
        value: num(p, valor.dataKey, date),
        mortgage: num(p, mortgage.dataKey, date),
        deposited: num(p, own.depositDataKey!, date),
        equity: num(p, own.dataKey, date),
      };
    });
}

function propertyValueBand(
  ledger: readonly DeptoMortgageSheetRow[],
  points: DeptoValuePointDto[],
  unit: TsUnit,
  asOf: string
): DeptoPropertyValueBandDto {
  const last = ledger[ledger.length - 1]!;
  const pieRow = ledger.find((r) => isDeptoPieCuota(r.cuota));
  if (!pieRow) throw new Error("depto glance: the ledger has no pie row");
  const loanCurrency = last.loan_currency;
  const appraisalLoan = requireNumber(last.valor_vivienda_loan, "appraisal");
  const owned = requireNumber(last.valor_neto_loan, "net equity");
  const owed = requireNumber(last.credito_restante_loan, "loan balance");
  if (Math.abs(owned + owed - appraisalLoan) > 1e-3) {
    throw new Error(`depto glance: net equity ${owned} + balance ${owed} ≠ appraisal ${appraisalLoan}`);
  }
  const valueNow = valueIn(appraisalLoan, loanCurrency, unit, asOf, "asset", "the appraisal today");
  const pieAppraisal = requireNumber(pieRow.valor_vivienda_loan, "appraisal at purchase");
  const valueThen = valueIn(pieAppraisal, loanCurrency, unit, pieRow.occurred_on, "asset", "the appraisal at purchase");
  return {
    points,
    prepagos: ledger
      .filter((r) => isDeptoPrepagoCuota(r.cuota))
      .map((r) => ({ date: r.occurred_on, amount_loan: requireNumber(r.amortizacion_total_loan, `prepago ${r.cuota}'s amortization`) })),
    ownership: {
      owned_loan: owned,
      owed_loan: owed,
      owned_share: share(owned, appraisalLoan),
      owed_share: share(owed, appraisalLoan),
    },
    appraisal: { value_loan: appraisalLoan, value: valueNow },
    purchase: {
      date: pieRow.occurred_on,
      value: valueThen,
      revaluation: valueNow - valueThen,
      revaluation_pct: valueNow / valueThen - 1,
    },
    pie: {
      pie_loan: requireNumber(pieRow.pago_loan, "pie in the loan currency"),
      pie: convertFlow(pieRow.pago_pay, pieRow.payment_currency, unit, pieRow.occurred_on),
    },
  };
}

function plMonths(monthly: readonly AccountMonthlyPerformanceRow[]): DeptoPlMonthDto[] {
  const asc = [...monthly].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  let cumulative = 0;
  return asc.map((r, i) => {
    const pl = requireNumber(r.nominal_pl, `P/L of ${r.as_of_date}`);
    cumulative += pl;
    const prior = i > 0 ? asc[i - 1]!.closing_value : null;
    return {
      month: monthKeyFromYmd(r.as_of_date),
      pl,
      pl_cumulative: cumulative,
      closing: r.closing_value,
      value_change: prior == null ? null : r.closing_value - prior,
    };
  });
}

function plYears(months: readonly DeptoPlMonthDto[], yearly: readonly AccountMonthlyPerformanceRow[]): DeptoPropertyPlBandDto["years"] {
  const byYear = new Map<string, DeptoPlMonthDto[]>();
  for (const m of months) {
    const y = m.month.slice(0, 4);
    const list = byYear.get(y) ?? [];
    list.push(m);
    byYear.set(y, list);
  }
  return [...byYear.entries()].map(([year, list]) => {
    const yearRow = yearly.find((r) => r.as_of_date.slice(0, 4) === year);
    const pl = requireNumber(yearRow?.nominal_pl, `P/L of ${year}`);
    const summed = list.reduce((s, m) => s + m.pl, 0);
    if (Math.abs(summed - pl) > 1e-6 * Math.max(1, Math.abs(pl)) + 1e-6) {
      throw new Error(`depto glance: ${year}'s months add up to ${summed}, its year row says ${pl}`);
    }
    return {
      year,
      first_month: list[0]!.month,
      last_month: list[list.length - 1]!.month,
      pl,
      value_change: list.reduce((s, m) => s + (m.value_change ?? 0), 0),
    };
  });
}

/**
 * This month's P/L split (see the module comment): the payments' part that did not become equity,
 * and the loan currency's move on the property net of the balance's indexation. `points` are the
 * property's chart points (the last today, the one before the previous month-end).
 */
export function deptoMonthSplit(args: {
  points: readonly DeptoValuePointDto[];
  ledger: readonly DeptoMortgageSheetRow[];
  unit: TsUnit;
  pl: number;
}): DeptoMonthSplitDto | null {
  const { points, ledger, unit, pl } = args;
  const end = points[points.length - 1];
  const start = points[points.length - 2];
  if (!end || !start) return null;
  const month = end.date.slice(0, 7);
  if (start.date !== monthEndUtcYmd(addCalendarMonths(month, -1))) {
    throw new Error(`depto glance: the point before ${end.date} is ${start.date}, not the previous month-end`);
  }
  const payments = ledger.filter((r) => !isDeptoPieCuota(r.cuota) && r.occurred_on > start.date && r.occurred_on <= end.date);
  let paid = 0;
  let amortized = 0;
  for (const r of payments) {
    paid += convertFlow(r.pago_pay, r.payment_currency, unit, r.occurred_on);
    amortized += convertFlow(requireNumber(r.amortizacion_total_pay, `${r.cuota}'s amortization`), r.payment_currency, unit, r.occurred_on);
  }
  const cuotaPart = amortized - paid;
  const currencyPart = end.value - start.value - (end.mortgage - start.mortgage + amortized);
  const tol = 2 * currencySmallestCoin(unit);
  if (Math.abs(cuotaPart + currencyPart - pl) > tol) {
    throw new Error(
      `depto glance: ${month}'s split ${cuotaPart} + ${currencyPart} does not add up to its P/L ${pl}`
    );
  }
  // The property's move in the display unit beyond what the payments explain: the loan currency
  // against the unit (UF indexation in pesos; any rate move when the unit is another currency).
  // None when it did not move (a loan in the display unit's own currency).
  const moved = Math.abs(currencyPart) > tol;
  const larger = Math.max(Math.abs(cuotaPart), moved ? Math.abs(currencyPart) : 0);
  return {
    month,
    pl,
    cuotas: payments.map((r) => r.cuota),
    cuota_part: cuotaPart,
    currency_part: moved ? currencyPart : null,
    cuota_share: share(Math.abs(cuotaPart), larger),
    currency_share: moved ? share(Math.abs(currencyPart), larger) : 0,
  };
}

const EQUITY_KINDS: ReadonlySet<string> = new Set(["mortgage_amortization", "mortgage_extra_amortization"]);

/** The property's cost of living, or null when no tracked place names the property. */
function propertyCostBand(propertyId: number, unit: TsUnit, asOf: string): DeptoCostBandDto | null {
  const { places, slots } = realEstateBillSlotsReadOnly();
  const mine = places.filter((p) => p.property_account_id === propertyId);
  if (mine.length === 0) return null;
  if (mine.length > 1) {
    throw new Error(`depto glance: property ${propertyId} is the home of several places (${mine.map((p) => p.slug).join(", ")})`);
  }
  const place = mine[0]!;
  const parts: { month: string; kind: string; amount: number }[] = [];
  for (const slot of slots) {
    if (slot.account_slug !== place.slug) continue;
    for (const { month, kind, amount } of chartedBillParts(slot)) {
      parts.push({ month, kind, amount: convertFlow(amount, slot.currency, unit, slot.spent_on) });
    }
  }
  return deptoCostBand({ placeSlug: place.slug, parts, currentMonth: asOf.slice(0, 7) });
}

/** The cost band from bill parts already in the unit (one per month and kind, or several to add). */
export function deptoCostBand(args: {
  placeSlug: string;
  parts: readonly { month: string; kind: string; amount: number }[];
  currentMonth: string;
}): DeptoCostBandDto | null {
  const { placeSlug, parts, currentMonth } = args;
  if (parts.length === 0) return null;
  const kindOrder: readonly string[] = REAL_ESTATE_CHART_KINDS;
  for (const p of parts) {
    if (!kindOrder.includes(p.kind)) throw new Error(`depto glance: bill kind '${p.kind}' has no chart kind`);
  }
  const used = kindOrder.filter((k) => parts.some((p) => p.kind === k));
  const direction = (k: string): DeptoCostDirection => (EQUITY_KINDS.has(k) ? "equity" : "cost");
  const monthKeys = [...new Set(parts.map((p) => p.month))].sort();
  const first = monthKeys[0]!;
  const lastMonth = monthKeys[monthKeys.length - 1]!;
  const windowTo = addCalendarMonths(currentMonth, -2) < lastMonth ? addCalendarMonths(currentMonth, -2) : lastMonth;
  const windowFromWanted = addCalendarMonths(windowTo, -11);
  const windowFrom = windowFromWanted < first ? first : windowFromWanted;
  const hasWindow = windowTo >= first;

  const months: DeptoCostMonthDto[] = [];
  for (let m = first; m <= lastMonth; m = addCalendarMonths(m, 1)) {
    const values: Record<string, number> = Object.fromEntries(used.map((k) => [k, 0]));
    for (const p of parts) if (p.month === m) values[p.kind] = values[p.kind]! + p.amount;
    const cost = used.filter((k) => direction(k) === "cost").reduce((s, k) => s + values[k]!, 0);
    const equity = used.filter((k) => direction(k) === "equity").reduce((s, k) => s + values[k]!, 0);
    months.push({
      month: m,
      values,
      cost_total: cost,
      equity_total: equity,
      equity_over_cap: false,
      in_window: hasWindow && m >= windowFrom && m <= windowTo,
    });
  }
  const maxCost = Math.max(...months.map((m) => m.cost_total));
  const cap = niceCeil(maxCost > 0 ? maxCost : Math.max(...months.map((m) => m.equity_total)));
  for (const m of months) m.equity_over_cap = m.equity_total > cap;

  let window: DeptoCostBandDto["window"] = null;
  if (hasWindow) {
    const inWin = months.filter((m) => m.in_window);
    const totals = new Map(used.map((k) => [k, inWin.reduce((s, m) => s + m.values[k]!, 0)]));
    const cost = inWin.reduce((s, m) => s + m.cost_total, 0);
    const equity = inWin.reduce((s, m) => s + m.equity_total, 0);
    const ordered = [...used.filter((k) => direction(k) === "cost"), ...used.filter((k) => direction(k) === "equity")].filter(
      (k) => totals.get(k)! > 0
    );
    const largest = Math.max(0, ...ordered.map((k) => totals.get(k)!));
    window = {
      from: windowFrom,
      to: windowTo,
      total: cost + equity,
      cost,
      equity,
      cost_share: share(cost, cost + equity),
      equity_share: share(equity, cost + equity),
      rows: ordered.map((k) => ({ kind: k, direction: direction(k), total: totals.get(k)!, share: share(totals.get(k)!, largest) })),
    };
  }
  return {
    place_slug: placeSlug,
    kinds: used.map((k) => ({ kind: k, direction: direction(k) })),
    months,
    axis: { cap, ticks: [cap / 2, cap] },
    window,
  };
}

// ---------------------------------------------------------------------------------------------
// mortgage

function buildMortgage(
  accountId: number,
  ledger: readonly DeptoMortgageSheetRow[],
  input: DeptoGlanceInput,
  asOf: string
): DeptoMortgageGlanceDto {
  const { unit, row, perf, mortgageLedger } = input;
  const loanRows = ledger.filter((r) => !isDeptoPieCuota(r.cuota));
  const pieRows = ledger.filter((r) => isDeptoPieCuota(r.cuota));
  if (pieRows.length !== 1) throw new Error(`depto glance: the ledger has ${pieRows.length} pie rows`);
  const pie = pieRows[0]!;
  const nextScenario = (mortgageLedger.payment_scenarios ?? []).find((s) => s.is_next_payment) ?? null;

  // The prepaid-vs-invested block is not built here: it reads a benchmark series, and a stale one
  // must fail only its column (`GET /api/accounts/:id/depto-prepayments`), never the whole page.
  const payments = deptoPaymentsList({ loanRows, pie, next: nextScenario });

  const years = [...(perf!.yearly ?? [])]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((r) => ({ year: r.as_of_date.slice(0, 4), cost: requireNumber(r.nominal_pl, `financing cost of ${r.as_of_date.slice(0, 4)}`) }));
  const balance = deptoBalanceBand(ledger, {
    original_loan: requireNumber(mortgageLedger.meta?.hipoteca_tras_pie_loan, "the balance after the pie"),
    financing_cost: { total: requireNumber(row!.delta_total, "total financing cost"), years },
  });

  return {
    payments,
    balance,
    projection: nextScenario == null ? null : deptoProjection({ ledger, next: nextScenario, unit, asOf }),
  };
}

/** The «Dividendos» list: the next cuota, the Σ row, one row per payment (newest first). */
export function deptoPaymentsList(args: {
  loanRows: readonly DeptoMortgageSheetRow[];
  pie: DeptoMortgageSheetRow;
  next: NonNullable<AccountMortgageLedgerResponse["payment_scenarios"]>[number] | null;
}) {
  const { loanRows, pie, next } = args;
  if (loanRows.length === 0) throw new Error("depto glance: the loan has no payment");
  const regular = loanRows.filter((r) => !isDeptoPrepagoCuota(r.cuota));
  const scaleBasis = Math.max(0, ...regular.map((r) => requireNumber(r.pago_loan, `cuota ${r.cuota} in the loan currency`)));
  const scale = niceCeil(scaleBasis > 0 ? scaleBasis : requireNumber(loanRows[0]!.pago_loan, "payment in the loan currency"));

  const rows: DeptoPaymentRowDto[] = loanRows.map((r) => {
    const prepago = isDeptoPrepagoCuota(r.cuota);
    const paidLoan = requireNumber(r.pago_loan, `payment ${r.cuota} in the loan currency`);
    let number: number;
    if (prepago) number = prepagoOrdinal(r.cuota);
    else {
      const n = numericCuota(r.cuota);
      if (n == null) throw new Error(`depto glance: cuota label '${r.cuota}' is not a number`);
      number = n;
    }
    const bar: DeptoPaymentBarDto = prepago
      ? { segments: [{ part: "prepago", share: Math.min(1, paidLoan / scale) }], clipped: paidLoan > scale }
      : {
          segments: paymentSegments(r).map((s) => ({ part: s.part, share: s.amount / scale })),
          clipped: false,
        };
    return {
      key: r.cuota,
      kind: prepago ? "prepago" : "cuota",
      number,
      date: r.occurred_on,
      paid_loan: paidLoan,
      paid_pay: r.pago_pay,
      amortization_loan: r.amortizacion_loan,
      extra_loan: r.amortizacion_ext_loan,
      interest_loan: r.interes_loan,
      insurance_loan: r.total_seguros_loan,
      charge_loan: r.prepayment_charge_loan,
      balance_loan: requireNumber(r.credito_restante_loan, `balance after ${r.cuota}`),
      balance_pay: requireNumber(r.restante_pay, `balance after ${r.cuota} in the payment currency`),
      min_loan: prepago ? null : r.min_loan,
      bar,
    };
  });

  const sum = (pick: (r: DeptoMortgageSheetRow) => number | null) => loanRows.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const totalsParts = {
    amortization: sum((r) => r.amortizacion_loan),
    extra: sum((r) => r.amortizacion_ext_loan),
    interest: sum((r) => r.interes_loan),
    insurance: sum((r) => r.total_seguros_loan),
    charge: sum((r) => r.prepayment_charge_loan),
  };
  const partsTotal = Object.values(totalsParts).reduce((a, b) => a + b, 0);
  const last = loanRows[loanRows.length - 1]!;
  const paidPay = sum((r) => r.pago_pay);
  const amortPay = sum((r) => r.amortizacion_total_pay);
  const interestPay = sum((r) => r.interes_pay);
  // The Σ row restates the ledger's own running totals (the pie is no payment to the loan).
  const ledgerPaid = requireNumber(last.pago_acumulado_pay, "the ledger's paid total") - pie.pago_pay;
  if (Math.abs(paidPay - ledgerPaid) > 1) throw new Error(`depto glance: Σ paid ${paidPay} ≠ the ledger's ${ledgerPaid}`);
  // The pie is no payment to the loan: its row has no amortization or interest (null, not missing).
  const ledgerAmort = requireNumber(last.amort_acum_pay, "the ledger's amortization total") - (pie.amortizacion_total_pay ?? 0);
  if (Math.abs(amortPay - ledgerAmort) > 1) throw new Error(`depto glance: Σ amortization ${amortPay} ≠ the ledger's ${ledgerAmort}`);
  const ledgerInterest = requireNumber(last.interes_acum_pay, "the ledger's interest total") - (pie.interes_pay ?? 0);
  if (Math.abs(interestPay - ledgerInterest) > 1) throw new Error(`depto glance: Σ interest ${interestPay} ≠ the ledger's ${ledgerInterest}`);

  const totals: DeptoPaymentTotalsDto = {
    first_date: loanRows[0]!.occurred_on,
    count: loanRows.length,
    paid_loan: sum((r) => r.pago_loan),
    paid_pay: paidPay,
    amortization_loan: totalsParts.amortization,
    extra_loan: totalsParts.extra,
    amortization_total_pay: amortPay,
    interest_loan: totalsParts.interest,
    interest_pay: interestPay,
    insurance_loan: totalsParts.insurance,
    insurance_pay: sum((r) => r.total_seguros_pay),
    charge_loan: totalsParts.charge,
    charge_pay: sum((r) => r.prepayment_charge_pay),
    bar: {
      segments: (["amortization", "extra", "interest", "insurance", "charge"] as const)
        .filter((p) => totalsParts[p] > 0)
        .map((p) => ({ part: p, share: share(totalsParts[p], partsTotal) })),
      clipped: false,
    },
  };

  let nextDto: DeptoNextCuotaDto | null = null;
  if (next) {
    const max = next.scenarios.find((c) => c.term === "max") ?? null;
    const minLoan = requireNumber(next.min_payment_loan, `the next cuota's minimum`);
    nextDto = {
      cuota: next.cuota,
      date: next.occurred_on,
      min_loan: minLoan,
      min_pay: requireNumber(next.min_payment_pay, `the next cuota's minimum in the payment currency`),
      max_loan: max?.payment_loan ?? null,
      max_pay: max?.payment_pay ?? null,
      min_share: Math.min(1, minLoan / scale),
      max_share: max?.payment_loan != null ? Math.min(1, max.payment_loan / scale) : null,
      quoted: next.quoted === true,
    };
  }

  return {
    next: nextDto,
    totals,
    rows: rows.reverse(),
    bar_scale_loan: scale,
    default_benchmark: DEPTO_DEFAULT_PREPAY_BENCHMARK,
  };
}

function paymentSegments(r: DeptoMortgageSheetRow): { part: DeptoPaymentPart; amount: number }[] {
  const parts: [DeptoPaymentPart, number | null][] = [
    ["amortization", r.amortizacion_loan],
    ["extra", r.amortizacion_ext_loan],
    ["interest", r.interes_loan],
    ["insurance", r.total_seguros_loan],
    ["charge", r.prepayment_charge_loan],
  ];
  return parts.filter((p): p is [DeptoPaymentPart, number] => p[1] != null && p[1] > 0).map(([part, amount]) => ({ part, amount }));
}

/** The prepayment comparison as the payments list reads it: cells by row key, both bars' widths. */
export function deptoPrepayBlock(
  c: Pick<MortgagePrepaymentComparison, "benchmark" | "unit" | "rows" | "totals"> | null
): DeptoPrepayBlockDto | null {
  if (c == null) return null;
  const cell = (x: {
    extra: number;
    prepaid_value: number | null;
    invested_value: number | null;
    delta: number | null;
    delta_pct: number | null;
  }): DeptoPrepayCellDto => {
    const larger = Math.max(x.prepaid_value ?? 0, x.invested_value ?? 0);
    return {
      extra: x.extra,
      prepaid_value: x.prepaid_value,
      invested_value: x.invested_value,
      delta: x.delta,
      delta_pct: x.delta_pct,
      prepaid_share: x.prepaid_value == null ? null : share(x.prepaid_value, larger),
      invested_share: x.invested_value == null ? null : share(x.invested_value, larger),
    };
  };
  const rows: Record<string, DeptoPrepayCellDto> = {};
  for (const r of c.rows) {
    if (rows[r.cuota]) throw new Error(`depto glance: two prepayment rows for '${r.cuota}'`);
    rows[r.cuota] = cell(r);
  }
  return {
    benchmark: c.benchmark.slug,
    unit: c.unit,
    rows,
    totals: {
      ...cell(c.totals),
      covered_payments: c.totals.covered_payments,
      covered_from: c.totals.covered_from,
      prepaid_irr_pct: c.totals.prepaid_irr_pct,
      invested_irr_pct: c.totals.invested_irr_pct,
      irr_annualized: c.totals.irr_annualized,
    },
  };
}

/** `GET /api/accounts/:id/depto-prepayments`: the payments list's prepaid-vs-invested block for a benchmark. */
export function deptoPrepayBlockForBenchmark(accountId: number, benchmarkSlug: string, unit: TsUnit): DeptoPrepayBlockDto | null {
  const benchmark = getBenchmark(benchmarkSlug);
  if (!benchmark) return null;
  return deptoPrepayBlock(computeMortgagePrepaymentComparison({ accountId, benchmark, unit }));
}

/** The balance band from the whole ledger (pie first): steps, the paid/left bar, financing cost. */
export function deptoBalanceBand(
  ledger: readonly DeptoMortgageSheetRow[],
  extra: { original_loan: number; financing_cost: DeptoBalanceBandDto["financing_cost"] }
): DeptoBalanceBandDto {
  const points: DeptoBalancePointDto[] = [];
  let prepaid = 0;
  let prev: number | null = null;
  for (const r of ledger) {
    const bal = requireNumber(r.credito_restante_loan, `balance after ${r.cuota}`);
    if (isDeptoPieCuota(r.cuota)) {
      if (Math.abs(bal - extra.original_loan) > 1e-6) {
        throw new Error(`depto glance: the balance after the pie is ${bal}, the ledger's meta says ${extra.original_loan}`);
      }
      points.push({ date: r.occurred_on, balance_loan: bal, kind: "start", step_loan: null });
    } else if (isDeptoPrepagoCuota(r.cuota)) {
      if (prev == null) throw new Error(`depto glance: prepago ${r.cuota} before the pie`);
      const step = bal - prev;
      prepaid -= step;
      points.push({ date: r.occurred_on, balance_loan: bal, kind: "prepago", step_loan: step });
    } else {
      points.push({ date: r.occurred_on, balance_loan: bal, kind: "cuota", step_loan: null });
    }
    prev = bal;
  }
  if (points[0]?.kind !== "start") throw new Error("depto glance: the ledger does not open with the pie");
  const left = points[points.length - 1]!.balance_loan;
  const paid = extra.original_loan - left;
  return {
    points,
    original_loan: extra.original_loan,
    left_loan: left,
    paid_loan: paid,
    paid_share: share(paid, extra.original_loan),
    left_share: share(left, extra.original_loan),
    prepaid_loan: prepaid,
    cuotas_paid_loan: paid - prepaid,
    financing_cost: extra.financing_cost,
  };
}

/**
 * A payoff path from `balance` (see the module comment): `pace` amortizes a fixed amount each
 * cuota; `annuityCuotas` pays the annuity that ends after that many cuotas, recomputed each one.
 */
export function projectPayoff(args: {
  balance: number;
  monthlyRate: number;
  firstDate: string;
  asOf: string;
  mode: { pace: number } | { annuityCuotas: number };
}): DeptoPayoffPathDto {
  const { monthlyRate: r, firstDate, asOf, mode } = args;
  if (!(r >= 0) || !Number.isFinite(r)) throw new Error(`depto glance: monthly rate ${r} is not a rate`);
  let bal = args.balance;
  const path: { date: string; balance_loan: number }[] = [{ date: asOf, balance_loan: bal }];
  let interest = 0;
  let n = 0;
  let date = firstDate;
  if ("pace" in mode && !(mode.pace > 0)) throw new Error(`depto glance: usual pace ${mode.pace} pays nothing down`);
  if ("annuityCuotas" in mode && !(mode.annuityCuotas >= 1)) {
    throw new Error(`depto glance: ${mode.annuityCuotas} cuotas left on the minimum's term`);
  }
  while (bal > 1e-9) {
    if (n >= MAX_PROJECTED_CUOTAS) throw new Error(`depto glance: the payoff projection runs past ${MAX_PROJECTED_CUOTAS} cuotas`);
    const i = bal * r;
    let a: number;
    if ("pace" in mode) a = Math.min(mode.pace, bal);
    else {
      const k = mode.annuityCuotas - n;
      const pmt = r === 0 ? bal / k : (bal * r) / (1 - (1 + r) ** -k);
      a = Math.min(pmt - i, bal);
      if (k === 1) a = bal;
    }
    if (n > 0) date = addMonthKeepDay(date, 1);
    bal -= a;
    if (bal < 1e-9) bal = 0;
    interest += i;
    n += 1;
    path.push({ date, balance_loan: bal });
  }
  return {
    amortization_loan: "pace" in mode ? mode.pace : null,
    end_date: date,
    cuotas: n,
    years: n / 12,
    interest_loan: interest,
    path,
  };
}

/** The payoff projection, its three blocks and the term strip with the usual pace in it. */
export function deptoProjection(args: {
  /** The whole ledger, pie first: the row before a loan's first cuota is the pie's. */
  ledger: readonly DeptoMortgageSheetRow[];
  next: NonNullable<AccountMortgageLedgerResponse["payment_scenarios"]>[number];
  unit: TsUnit;
  asOf: string;
}): DeptoProjectionDto | null {
  const { ledger, next, unit, asOf } = args;
  if (!ledger[0] || !isDeptoPieCuota(ledger[0].cuota)) throw new Error("depto glance: the ledger does not open with the pie");
  const loanRows = ledger.slice(1);
  const regularIdx = loanRows.map((r, i) => (isDeptoPrepagoCuota(r.cuota) ? -1 : i)).filter((i) => i >= 0);
  if (regularIdx.length === 0) return null;
  const lastIdx = regularIdx[regularIdx.length - 1]!;
  const lastCuota = loanRows[lastIdx]!;
  const rate = loanMonthlyRate(ledger);
  if (rate == null) return null;
  const balance = requireNumber(loanRows[loanRows.length - 1]!.credito_restante_loan, "today's balance");
  const lastNumber = numericCuota(lastCuota.cuota);
  if (lastNumber == null) throw new Error(`depto glance: cuota '${lastCuota.cuota}' is not a number`);
  const pace = median(
    regularIdx.slice(-USUAL_PACE_CUOTAS).map((i) => requireNumber(loanRows[i]!.amortizacion_total_loan, `cuota ${loanRows[i]!.cuota}'s amortization`))
  );
  const usual = projectPayoff({ balance, monthlyRate: rate, firstDate: next.occurred_on, asOf, mode: { pace } });
  const minimum = projectPayoff({
    balance,
    monthlyRate: rate,
    firstDate: next.occurred_on,
    asOf,
    mode: { annuityCuotas: MORTGAGE_MINIMUM_TERM_CUOTAS - lastNumber },
  });
  const savingLoan = minimum.interest_loan - usual.interest_loan;
  const loanCurrency = lastCuota.loan_currency;

  const insurance = requireNumber(lastCuota.total_seguros_loan, `cuota ${lastCuota.cuota}'s insurance`);
  const usualPaymentLoan = Math.min(pace, balance) + balance * rate + insurance;
  const payRate = storedPairRate(loanCurrency, lastCuota.payment_currency, next.occurred_on);
  if (payRate == null) throw new Error(`depto glance: no ${loanCurrency}→${lastCuota.payment_currency} rate on or before ${next.occurred_on}`);
  const payCoin = 10 ** currencyMinorDigits(lastCuota.payment_currency);
  type Term = DeptoProjectionDto["terms"][number];
  const minimumYears = MORTGAGE_MINIMUM_TERM_CUOTAS / 12;
  const terms: Term[] = [
    {
      term: minimumYears as DeptoTermKey,
      years: minimumYears,
      payment_loan: next.min_payment_loan,
      payment_pay: next.min_payment_pay,
      highlighted: false,
    },
    ...next.scenarios.map(
      (c): Term => ({
        term: c.term as DeptoTermKey,
        years: c.term === "max" ? null : c.term,
        payment_loan: c.payment_loan,
        payment_pay: c.payment_pay,
        highlighted: false,
      })
    ),
  ];
  const usualTerm: Term = {
    term: "usual",
    years: usual.years,
    payment_loan: usualPaymentLoan,
    payment_pay: Math.round(usualPaymentLoan * payRate.mid * payCoin) / payCoin,
    highlighted: true,
  };
  const at = terms.findIndex((t) => t.years == null || t.years < usual.years);
  terms.splice(at < 0 ? terms.length : at, 0, usualTerm);

  return {
    monthly_rate: rate,
    usual,
    minimum,
    saving: {
      interest_loan: savingLoan,
      interest: valueIn(savingLoan, loanCurrency, unit, asOf, "debt", "the interest saved"),
      years_earlier: minimum.years - usual.years,
    },
    terms,
  };
}
