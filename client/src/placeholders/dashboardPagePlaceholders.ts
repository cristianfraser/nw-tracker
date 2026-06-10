import type { DashboardBundle } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import { DASHBOARD_NET_WORTH_BUCKET_SLUGS } from "../portfolioDashboardBuckets";
import type { DashboardResponse, TimeseriesBlock, ValuationTimeseriesResponse } from "../types";
import { monthEndYmdsThroughToday } from "./placeholderMonthRows";

function unitForTs(unit: DisplayUnit): "clp" | "usd" {
  return unit === "usd" ? "usd" : "clp";
}

const OVERVIEW_LINE_SPECS: {
  dataKey: string;
  name: string;
  valueSeriesType: "data" | "reference";
}[] = [
  { dataKey: "real_estate", name: "Inmuebles", valueSeriesType: "data" },
  { dataKey: "retirement", name: "Retiro", valueSeriesType: "data" },
  { dataKey: "brokerage", name: "Brokerage", valueSeriesType: "data" },
  { dataKey: "invested", name: "Invested", valueSeriesType: "reference" },
  { dataKey: "cash", name: "Cash savings", valueSeriesType: "data" },
  { dataKey: "liabilities", name: "Pasivos", valueSeriesType: "data" },
  { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
];

function zeroPointsForKeys(keys: string[]): Record<string, string | number | null>[] {
  return monthEndYmdsThroughToday().map((as_of_date) => {
    const row: Record<string, string | number | null> = { as_of_date };
    for (const k of keys) row[k] = 0;
    return row;
  });
}

/** Flat-zero overview + primary blocks for home dashboard charts while bundle loads. */
export function buildPlaceholderDashboardTimeseries(unit: DisplayUnit): ValuationTimeseriesResponse {
  const overviewKeys = OVERVIEW_LINE_SPECS.map((s) => s.dataKey);
  const accountsExProperty: TimeseriesBlock = {
    lines: [{ dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" }],
    points: zeroPointsForKeys(["total_nw"]),
  };
  return {
    unit: unitForTs(unit),
    overview: { lines: OVERVIEW_LINE_SPECS, points: zeroPointsForKeys(overviewKeys) },
    accounts_ex_property: accountsExProperty,
  };
}

/** Minimal dash payload so allocation pie and card strip can mount at zero. */
export function buildPlaceholderDashboardDash(unit: DisplayUnit): DashboardResponse {
  const includeUsd = unit === "usd";
  const zeroBucketCloses = {
    net_worth_clp: 0,
    real_estate_clp: 0,
    retirement_clp: 0,
    brokerage_clp: 0,
    cash_eqs_clp: 0,
    ...(includeUsd
      ? {
          net_worth_usd: 0,
          real_estate_usd: 0,
          retirement_usd: 0,
          brokerage_usd: 0,
          cash_eqs_usd: 0,
        }
      : {}),
  };
  return {
    totals: {
      net_worth_clp: 0,
      deposits_clp: 0,
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
      liabilities_clp: 0,
      prior_closes: {
        month_end: "",
        year_end: "",
        month: zeroBucketCloses,
        year: zeroBucketCloses,
      },
      ...(includeUsd
        ? {
            net_worth_usd: 0,
            deposits_usd: 0,
            real_estate_usd: 0,
            retirement_usd: 0,
            brokerage_usd: 0,
            cash_eqs_usd: 0,
            liabilities_usd: 0,
          }
        : {}),
    },
    allocation: DASHBOARD_NET_WORTH_BUCKET_SLUGS.map((group_slug) => ({
      group_slug,
      group_label: group_slug,
      value_clp: 1,
      ...(includeUsd ? { value_usd: 1 } : {}),
    })),
    accounts: [],
  };
}

export function buildPlaceholderDashboardBundle(unit: DisplayUnit): DashboardBundle {
  return {
    dash: buildPlaceholderDashboardDash(unit),
    ts: buildPlaceholderDashboardTimeseries(unit),
    fx: null,
    retirementPerf: null,
    brokeragePerf: null,
  };
}
