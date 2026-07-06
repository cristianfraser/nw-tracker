/**
 * Net-worth projections (/projections): one **real** (today's-money) trajectory in the display
 * unit — accumulation compounds the invested portion monthly and adds the aporte; the
 * non-invested remainder (real estate, cash) holds its purchasing power flat — then, from the
 * retirement month, three comparable drawdown strategies over the total balance. Nominal lines
 * derive from the real path with the unit's inflation input: projecting two independent nominal
 * paths per currency would drift incoherently, so both currency views share the real trajectory.
 *
 * The engine is pure (`runProjectionEngine`); the endpoint seeds defaults from history
 * (`buildProjectionsPayload`): base = last dashboard overview point, aporte = trailing-24-month
 * average of personal deposits into retirement + brokerage accounts.
 */
import { getDashboardOverviewBlock, type TsUnit } from "./valuationTimeseries.js";
import { loadMergedDisplayDepositInflowEvents } from "./accountDeposits.js";
import { accountIdsInPortfolioGroupForTotals } from "./portfolioGroupTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxRowOnOrBefore } from "./fxRates.js";

/** User's birth month — retirement age is measured from here. */
export const PROJECTION_BIRTH_MONTH = "1992-01";
export const PROJECTION_RETIRE_AGE = 65;

/** USD reference levels for the projection horizon (superset of the patrimonio milestones). */
export const PROJECTION_USD_MILESTONES = [250_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000] as const;

export type ProjectionParams = {
  /** Annual real return during accumulation (%). */
  real_return_pct: number;
  /** Monthly aporte in CLP, today's money. */
  monthly_aporte_clp: number;
  inflation_clp_pct: number;
  inflation_usd_pct: number;
  /** Annual real return after retirement (%). */
  retire_return_pct: number;
  end_age: number;
  /** Strategy 1: X% of the retirement balance per year, constant in real terms. */
  swr_pct: number;
  /** Strategy 2: Y% of the current balance per year. */
  pct_balance_pct: number;
  /** Strategy 3: fixed real monthly income in CLP, today's money (0 = defaults to the SWR income). */
  monthly_income_clp: number;
};

export const PROJECTION_PARAM_BOUNDS: Record<keyof ProjectionParams, [number, number]> = {
  real_return_pct: [-5, 20],
  monthly_aporte_clp: [0, 1_000_000_000],
  inflation_clp_pct: [0, 30],
  inflation_usd_pct: [0, 30],
  retire_return_pct: [-5, 20],
  end_age: [PROJECTION_RETIRE_AGE + 1, 110],
  swr_pct: [0, 25],
  pct_balance_pct: [0, 25],
  monthly_income_clp: [0, 1_000_000_000],
};

function monthAdd(mk: string, n: number): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function monthsBetween(fromMk: string, toMk: string): number {
  const [fy, fm] = fromMk.split("-").map(Number);
  const [ty, tm] = toMk.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

function monthEndYmd(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** Age in whole years at the given month. */
export function ageAtMonth(mk: string): number {
  return Math.floor(monthsBetween(PROJECTION_BIRTH_MONTH, mk) / 12);
}

function monthlyRate(annualPct: number): number {
  return Math.pow(1 + annualPct / 100, 1 / 12) - 1;
}

export type ProjectionEngineInput = {
  /** Total net worth and invested portion, display unit, today's money. */
  base_total: number;
  base_invested: number;
  /** First projected month (YYYY-MM). */
  start_month: string;
  monthly_aporte: number;
  real_return_pct: number;
  retire_return_pct: number;
  /** The display unit's inflation (nominal line derivation). */
  inflation_pct: number;
  end_age: number;
  swr_pct: number;
  pct_balance_pct: number;
  /** Fixed real monthly income; 0 → replaced by the SWR income at retirement. */
  monthly_income: number;
  /** What the drawdown strategies run on: the invested portfolio only (FIRE framing —
   * RE/cash keep their real value on the side) or the total balance. */
  drawdown_base: "invested" | "total";
};

export type ProjectionEngineResult = {
  points: Record<string, string | number | null>[];
  retire_month: string;
  /** The drawdown base at the retirement month (invested or total, per `drawdown_base`). */
  balance_at_retire: number;
  invested_at_retire: number;
  total_at_retire: number;
  swr_monthly_income: number;
  pct_balance_initial_monthly_income: number;
  fixed_monthly_income: number;
  /** Age when the strategy's balance hits zero; null = lasts past end_age. */
  swr_depletion_age: number | null;
  fixed_income_depletion_age: number | null;
};

export function runProjectionEngine(input: ProjectionEngineInput): ProjectionEngineResult {
  const retireMonth = monthAdd(PROJECTION_BIRTH_MONTH, PROJECTION_RETIRE_AGE * 12);
  const endMonth = monthAdd(PROJECTION_BIRTH_MONTH, input.end_age * 12);
  if (input.start_month >= retireMonth) {
    throw new Error(`start_month ${input.start_month} is past the retirement month ${retireMonth}`);
  }
  const rAcc = monthlyRate(input.real_return_pct);
  const rRet = monthlyRate(input.retire_return_pct);
  const inflM = monthlyRate(input.inflation_pct);
  const other = input.base_total - input.base_invested;

  const points: Record<string, string | number | null>[] = [];

  // Accumulation: invested compounds + aporte; "other" (RE, cash) holds real value flat.
  let invested = input.base_invested;
  let monthsFromStart = 0;
  for (let mk = input.start_month; mk <= retireMonth; mk = monthAdd(mk, 1)) {
    invested = invested * (1 + rAcc) + input.monthly_aporte;
    monthsFromStart += 1;
    const real = invested + other;
    points.push({
      as_of_date: monthEndYmd(mk),
      proj_nw: Math.round(real),
      proj_invested: Math.round(invested),
      proj_nw_nominal: Math.round(real * Math.pow(1 + inflM, monthsFromStart)),
    });
  }

  const investedAtRetire = invested;
  const totalAtRetire = invested + other;
  const balanceAtRetire = input.drawdown_base === "total" ? totalAtRetire : investedAtRetire;
  const swrMonthly = (balanceAtRetire * input.swr_pct) / 100 / 12;
  const fixedMonthly = input.monthly_income > 0 ? input.monthly_income : swrMonthly;
  const pctInitialMonthly = (balanceAtRetire * input.pct_balance_pct) / 100 / 12;

  // Decumulation: each strategy runs on its own copy of the total balance.
  let swr = balanceAtRetire;
  let pctBal = balanceAtRetire;
  let fixed = balanceAtRetire;
  let swrDepletion: number | null = null;
  let fixedDepletion: number | null = null;
  const retirePoint = points[points.length - 1]!;
  retirePoint.proj_swr = Math.round(swr);
  retirePoint.proj_pct_balance = Math.round(pctBal);
  retirePoint.proj_fixed_income = Math.round(fixed);

  for (let mk = monthAdd(retireMonth, 1); mk <= endMonth; mk = monthAdd(mk, 1)) {
    const row: Record<string, string | number | null> = { as_of_date: monthEndYmd(mk) };
    if (swr > 0) {
      swr = swr * (1 + rRet) - swrMonthly;
      if (swr <= 0) {
        swr = 0;
        if (swrDepletion == null) swrDepletion = ageAtMonth(mk);
      }
      row.proj_swr = Math.round(swr);
    }
    pctBal = pctBal * (1 + rRet) - (pctBal * input.pct_balance_pct) / 100 / 12;
    row.proj_pct_balance = Math.round(pctBal);
    if (fixed > 0) {
      fixed = fixed * (1 + rRet) - fixedMonthly;
      if (fixed <= 0) {
        fixed = 0;
        if (fixedDepletion == null) fixedDepletion = ageAtMonth(mk);
      }
      row.proj_fixed_income = Math.round(fixed);
    }
    points.push(row);
  }

  return {
    points,
    retire_month: retireMonth,
    balance_at_retire: Math.round(balanceAtRetire),
    invested_at_retire: Math.round(investedAtRetire),
    total_at_retire: Math.round(totalAtRetire),
    swr_monthly_income: Math.round(swrMonthly),
    pct_balance_initial_monthly_income: Math.round(pctInitialMonthly),
    fixed_monthly_income: Math.round(fixedMonthly),
    swr_depletion_age: swrDepletion,
    fixed_income_depletion_age: fixedDepletion,
  };
}

/** Trailing-24-month average of personal deposits into retirement + brokerage accounts (CLP/month). */
export function defaultMonthlyAporteClp(): number {
  const ids = [
    ...accountIdsInPortfolioGroupForTotals("retirement"),
    ...accountIdsInPortfolioGroupForTotals("brokerage"),
  ];
  if (ids.length === 0) return 0;
  const cutoff = monthAdd(chileCalendarTodayYmd().slice(0, 7), -24);
  let total = 0;
  for (const events of loadMergedDisplayDepositInflowEvents(ids).values()) {
    for (const e of events) {
      if (e.occurred_on.slice(0, 7) >= cutoff && e.amt > 0) total += e.amt;
    }
  }
  return Math.round(total / 24);
}

export const PROJECTION_DEFAULTS: Omit<ProjectionParams, "monthly_aporte_clp"> = {
  real_return_pct: 5,
  inflation_clp_pct: 3.5,
  inflation_usd_pct: 2.5,
  retire_return_pct: 4,
  end_age: 95,
  swr_pct: 4,
  pct_balance_pct: 5,
  monthly_income_clp: 0,
};

const LINE_SPECS: { dataKey: string; name: string; valueSeriesType: "data" | "reference" }[] = [
  { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
  { dataKey: "invested", name: "Invertido", valueSeriesType: "data" },
  { dataKey: "proj_nw", name: "Proyección (real)", valueSeriesType: "reference" },
  { dataKey: "proj_invested", name: "Invertido (proyección)", valueSeriesType: "reference" },
  { dataKey: "proj_nw_nominal", name: "Proyección (nominal)", valueSeriesType: "reference" },
  { dataKey: "proj_swr", name: "Retiro SWR", valueSeriesType: "reference" },
  { dataKey: "proj_pct_balance", name: "Retiro % del saldo", valueSeriesType: "reference" },
  { dataKey: "proj_fixed_income", name: "Retiro renta fija", valueSeriesType: "reference" },
];

export type ProjectionDrawdownBase = "invested" | "total";

export function buildProjectionsPayload(
  unit: TsUnit,
  params: ProjectionParams,
  drawdownBase: ProjectionDrawdownBase = "invested"
) {
  const fxRow = fxRowOnOrBefore(chileCalendarTodayYmd());
  if (!fxRow) throw new Error("no fx_daily row available (run backfill:yahoo-fx-usd)");
  const fx = fxRow.clp_per_usd;

  const overview = getDashboardOverviewBlock(unit);
  const historical = overview.points.filter(
    (p) => typeof p.total_nw === "number" && Number.isFinite(p.total_nw)
  );
  const last = historical[historical.length - 1];
  if (!last) throw new Error("no historical net-worth points to project from");
  const baseTotal = Number(last.total_nw);
  const baseInvested = typeof last.invested === "number" ? last.invested : 0;

  const toUnit = (clp: number) => (unit === "usd" ? clp / fx : clp);
  const startMonth = monthAdd(String(last.as_of_date).slice(0, 7), 1);

  const engine = runProjectionEngine({
    base_total: baseTotal,
    base_invested: baseInvested,
    start_month: startMonth,
    monthly_aporte: toUnit(params.monthly_aporte_clp),
    real_return_pct: params.real_return_pct,
    retire_return_pct: params.retire_return_pct,
    inflation_pct: unit === "usd" ? params.inflation_usd_pct : params.inflation_clp_pct,
    end_age: params.end_age,
    swr_pct: params.swr_pct,
    pct_balance_pct: params.pct_balance_pct,
    monthly_income: toUnit(params.monthly_income_clp),
    drawdown_base: drawdownBase,
  });

  // Milestones as constant reference columns over the whole x-range (USD levels; CLP view
  // converts at today's fx — every line on this chart is today's money).
  const milestoneCols: Record<string, number> = {};
  for (const usd of PROJECTION_USD_MILESTONES) {
    milestoneCols[`usd_${usd / 1000}k`] = Math.round(unit === "usd" ? usd : usd * fx);
  }
  const decorate = (row: Record<string, string | number | null>) => ({ ...row, ...milestoneCols });

  const histRows = historical.map((p) =>
    decorate({ as_of_date: p.as_of_date, total_nw: p.total_nw, invested: p.invested ?? null })
  );
  const points = [...histRows, ...engine.points.map(decorate)];

  const lines = [
    ...LINE_SPECS,
    ...PROJECTION_USD_MILESTONES.map((usd) => ({
      dataKey: `usd_${usd / 1000}k`,
      name: `${usd / 1000}k USD`,
      valueSeriesType: "reference" as const,
    })),
  ];

  return {
    unit,
    fx_clp_per_usd: fx,
    params,
    drawdown_base: drawdownBase,
    retire_month: engine.retire_month,
    retire_age: PROJECTION_RETIRE_AGE,
    summary: {
      balance_at_retire: engine.balance_at_retire,
      invested_at_retire: engine.invested_at_retire,
      total_at_retire: engine.total_at_retire,
      swr_monthly_income: engine.swr_monthly_income,
      pct_balance_initial_monthly_income: engine.pct_balance_initial_monthly_income,
      fixed_monthly_income: engine.fixed_monthly_income,
      swr_depletion_age: engine.swr_depletion_age,
      fixed_income_depletion_age: engine.fixed_income_depletion_age,
    },
    chart: { points, lines },
  };
}
