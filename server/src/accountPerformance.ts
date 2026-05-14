import { getAccountValuationTimeseries, listAccountsForGroupTab } from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";

export type AccountMonthlyPerformanceRow = {
  as_of_date: string;
  /** Closing value at month-end (same unit as request: CLP or USD). */
  closing_value: number;
  prior_closing: number | null;
  /** Net capital flow in the month (Δ cumulative aportes vs prior month-end). */
  net_capital_flow: number;
  /** Sum of positive `brokerage_flows.units_delta` in the calendar month of this row (purchases + reinvest DRIP). */
  stock_units_inflow: number;
  /** V_close − V_prior − net_capital_flow (gain/loss beyond explained flows). */
  nominal_pl: number | null;
  /** nominal_pl / (prior_closing + net_capital_flow) when denominator magnitude is meaningful. */
  pct_month: number | null;
  /** Sum of nominal_pl from January of this row’s calendar year through this month (same unit). */
  ytd_nominal_pl: number | null;
  /** Running sum of nominal_pl from first month with a row through this month. */
  cumulative_nominal_pl: number | null;
  unit: TsUnit;
};

function numCell(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Month-end `YYYY-MM-DD` → Σ positive units_delta on `brokerage_flows` in that calendar month. */
function stockUnitsInflowByMonthEnd(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT occurred_on, COALESCE(units_delta, 0) AS ud
       FROM brokerage_flows
       WHERE account_id = ? AND COALESCE(units_delta, 0) > 0`
    )
    .all(accountId) as { occurred_on: string; ud: number }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    const me = monthEndUtcYmd(monthKeyFromYmd(r.occurred_on));
    m.set(me, (m.get(me) ?? 0) + r.ud);
  }
  return m;
}

/**
 * Month-on-month investment-style metrics from existing valuations + merged capital flows
 * (same series as the account valuation chart). Not persisted.
 *
 * Skips **cuenta_corriente** (no P/L framing). Uses **monthly** granularity only (daily chart has no deposit line).
 * The **first** month with a valuation row is included: `prior_closing` is null and `net_capital_flow` equals cumulative
 * aportes at that date (so e.g. VEA’s March 2026 wires appear in March, not folded into April as ΔcumDep=0).
 */
export function getAccountMonthlyPerformance(
  accountId: number,
  unit: TsUnit = "clp"
): { account_id: number; category_slug: string; monthly: AccountMonthlyPerformanceRow[] } | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { id: number; category_slug: string } | undefined;
  if (!row) return null;

  if (row.category_slug === "cuenta_corriente") {
    return { account_id: accountId, category_slug: row.category_slug, monthly: [] };
  }

  const ts = getAccountValuationTimeseries(accountId, unit, {});
  if (!ts || ts.granularity !== "monthly" || !ts.accounts.points.length) {
    return { account_id: accountId, category_slug: row.category_slug, monthly: [] };
  }

  const dk = String(accountId);
  const depKey = `${dk}__dep`;
  const pts = [...ts.accounts.points].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));

  let prevClose: number | null = null;
  let prevCumDep: number | null = null;
  const outAsc: AccountMonthlyPerformanceRow[] = [];
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  const unitsByMonthEnd = stockUnitsInflowByMonthEnd(accountId);

  for (const p of pts) {
    const close = numCell(p[dk]);
    if (close == null) continue;
    const cumDep = numCell(p[depKey]) ?? 0;

    if (prevClose == null) {
      const asOf = String(p.as_of_date);
      const y = Number(asOf.slice(0, 4));
      if (!Number.isFinite(y)) {
        prevClose = close;
        prevCumDep = cumDep;
        continue;
      }
      ytdYear = y;
      ytdRun = 0;
      /** First month in the series: no prior month-end — net flow = cumulative aportes at this date (vs 0). */
      const netFlowFirst = cumDep;
      const nominalFirst = close - netFlowFirst;
      const pctFirst =
        Math.abs(netFlowFirst) > 1e-6 && Number.isFinite(nominalFirst / netFlowFirst)
          ? nominalFirst / netFlowFirst
          : null;
      ytdRun += nominalFirst;
      cumPl += nominalFirst;
      outAsc.push({
        as_of_date: asOf,
        closing_value: close,
        prior_closing: null,
        net_capital_flow: netFlowFirst,
        stock_units_inflow: unitsByMonthEnd.get(asOf) ?? 0,
        nominal_pl: nominalFirst,
        pct_month: pctFirst,
        ytd_nominal_pl: ytdRun,
        cumulative_nominal_pl: cumPl,
        unit,
      });
      prevClose = close;
      prevCumDep = cumDep;
      continue;
    }

    const netFlow = cumDep - (prevCumDep ?? 0);
    const nominal = close - prevClose - netFlow;
    const denom = prevClose + netFlow;
    const pct =
      Math.abs(denom) > 1e-6 && Number.isFinite(nominal / denom) ? nominal / denom : null;

    const y = Number(String(p.as_of_date).slice(0, 4));
    if (!Number.isFinite(y)) {
      prevClose = close;
      prevCumDep = cumDep;
      continue;
    }
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += nominal;
    cumPl += nominal;

    outAsc.push({
      as_of_date: String(p.as_of_date),
      closing_value: close,
      prior_closing: prevClose,
      net_capital_flow: netFlow,
      stock_units_inflow: unitsByMonthEnd.get(String(p.as_of_date)) ?? 0,
      nominal_pl: nominal,
      pct_month: pct,
      ytd_nominal_pl: ytdRun,
      cumulative_nominal_pl: cumPl,
      unit,
    });

    prevClose = close;
    prevCumDep = cumDep;
  }

  const monthly = [...outAsc].reverse();
  return { account_id: accountId, category_slug: row.category_slug, monthly };
}

export type GroupMonthlyPerformanceBarAccount = {
  account_id: number;
  name: string;
  /** Point field for this account’s monthly nominal P/L (e.g. `pl_12`). */
  bar_data_key: string;
};

/**
 * Per-class tab: per-account monthly P/L bars + group YTD area (resets each Jan) + ΣΔ line, and
 * `accumulated_earnings` (running sum of `delta_total` since first month, no reset).
 * Skips `cuenta_corriente` and accounts with no monthly P/L rows.
 */
export function getGroupMonthlyPerformanceSeries(
  groupSlug: string,
  unit: TsUnit = "clp"
): {
  unit: TsUnit;
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
} {
  const rows = listAccountsForGroupTab(groupSlug);
  const perfRows = rows.filter((r) => r.category_slug !== "cuenta_corriente");

  const byIdAsc = new Map<number, AccountMonthlyPerformanceRow[]>();
  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = [];

  for (const r of perfRows) {
    const p = getAccountMonthlyPerformance(r.account_id, unit);
    if (!p || p.monthly.length === 0) continue;
    const asc = [...p.monthly].reverse();
    byIdAsc.set(r.account_id, asc);
    bar_accounts.push({
      account_id: r.account_id,
      name: r.name,
      bar_data_key: `pl_${r.account_id}`,
    });
  }

  const dateSet = new Set<string>();
  for (const asc of byIdAsc.values()) {
    for (const row of asc) dateSet.add(row.as_of_date);
  }
  const datesAsc = [...dateSet].sort((a, b) => a.localeCompare(b));

  const nominalCell = new Map<string, number>();
  for (const [id, asc] of byIdAsc) {
    for (const row of asc) {
      const n = row.nominal_pl;
      nominalCell.set(
        `${id}|${row.as_of_date}`,
        n != null && Number.isFinite(n) ? n : 0
      );
    }
  }
  const nominalAt = (accountId: number, d: string) => nominalCell.get(`${accountId}|${d}`) ?? 0;

  const pointsAsc: Record<string, string | number | null>[] = [];
  let ytdYear = 0;
  let ytdRun = 0;
  let cumLife = 0;

  for (const d of datesAsc) {
    const pt: Record<string, string | number | null> = { as_of_date: d };
    let deltaTotal = 0;
    for (const ba of bar_accounts) {
      const v = nominalAt(ba.account_id, d);
      pt[ba.bar_data_key] = v;
      deltaTotal += v;
    }
    pt.delta_total = deltaTotal;

    const y = Number(String(d).slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += deltaTotal;
    pt.ytd_group = ytdRun;
    cumLife += deltaTotal;
    pt.accumulated_earnings = cumLife;

    pointsAsc.push(pt);
  }

  return {
    unit,
    group_slug: groupSlug,
    bar_accounts,
    points: pointsAsc,
  };
}

/**
 * Dashboard “Acciones” (SPY ± VEA): monthly Δ as sum of each ticker’s nominal P/L, area = cumulative sum from
 * first month with data (no calendar-year reset). Same per-account logic as {@link getAccountMonthlyPerformance}.
 */
export function getStocksLifetimeEarningsSeries(unit: TsUnit = "clp"): {
  unit: TsUnit;
  stock_accounts: { account_id: number; name: string }[];
  points: { as_of_date: string; delta_month: number; accumulated_earnings: number; ytd_merged: number }[];
} {
  const accStmt = db.prepare("SELECT id AS account_id, name FROM accounts WHERE notes = ?");
  const spy = accStmt.get("import:excel|key=spy") as { account_id: number; name: string } | undefined;
  const vea = accStmt.get("import:excel|key=vea") as { account_id: number; name: string } | undefined;
  const stock_accounts = [spy, vea].filter((x): x is { account_id: number; name: string } => x != null);
  if (stock_accounts.length === 0) {
    return { unit, stock_accounts: [], points: [] };
  }

  const byIdAsc = new Map<number, AccountMonthlyPerformanceRow[]>();
  for (const s of stock_accounts) {
    const p = getAccountMonthlyPerformance(s.account_id, unit);
    if (!p || p.monthly.length === 0) continue;
    byIdAsc.set(s.account_id, [...p.monthly].reverse());
  }
  if (byIdAsc.size === 0) {
    return { unit, stock_accounts, points: [] };
  }

  const dateSet = new Set<string>();
  for (const asc of byIdAsc.values()) {
    for (const row of asc) dateSet.add(row.as_of_date);
  }
  const datesAsc = [...dateSet].sort((a, b) => a.localeCompare(b));

  const nominalCell = new Map<string, number>();
  for (const [id, asc] of byIdAsc) {
    for (const row of asc) {
      const n = row.nominal_pl;
      nominalCell.set(`${id}|${row.as_of_date}`, n != null && Number.isFinite(n) ? n : 0);
    }
  }

  let cum = 0;
  let ytdYear = 0;
  let ytdRun = 0;
  const points = datesAsc.map((d) => {
    let deltaMonth = 0;
    for (const s of stock_accounts) {
      deltaMonth += nominalCell.get(`${s.account_id}|${d}`) ?? 0;
    }
    cum += deltaMonth;
    const y = Number(String(d).slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += deltaMonth;
    return { as_of_date: d, delta_month: deltaMonth, accumulated_earnings: cum, ytd_merged: ytdRun };
  });

  return { unit, stock_accounts, points };
}
