import i18n, { brokerageGroupLabel } from "./i18n";
import type {
  AccountListRow,
  GroupMonthlyPerformanceBarAccount,
  GroupMonthlyPerformanceResponse,
  TimeseriesAccountLine,
  TimeseriesBlock,
} from "./types";

export type BrokeragePortfolioGroup = "fondos_mutuos" | "acciones" | "cripto";

const GROUP_TAB_VAL_TOTAL = "__group_val_total";
const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

const G_META: Record<
  BrokeragePortfolioGroup,
  { dataKey: string; depKey: string; barDataKey: string; accountId: number }
> = {
  fondos_mutuos: {
    dataKey: "brk_fm",
    depKey: "brk_fm_dep",
    barDataKey: "pl_brk_fm",
    accountId: -201,
  },
  acciones: {
    dataKey: "brk_eq",
    depKey: "brk_eq_dep",
    barDataKey: "pl_brk_eq",
    accountId: -202,
  },
  cripto: {
    dataKey: "brk_cr",
    depKey: "brk_cr_dep",
    barDataKey: "pl_brk_cr",
    accountId: -203,
  },
};

/** Display / navigation order on the Brokerage page. */
export const BROKERAGE_GROUP_ORDER: readonly BrokeragePortfolioGroup[] = ["fondos_mutuos", "acciones", "cripto"];

export function brokeragePortfolioGroupLabel(g: BrokeragePortfolioGroup): string {
  return brokerageGroupLabel(g);
}

/** React Router path for a brokerage subgroup (matches API `subgroup`). */
export function brokeragePortfolioGroupPath(g: BrokeragePortfolioGroup): string {
  if (g === "fondos_mutuos") return "/inversiones/brokerage/fondos-mutuos";
  if (g === "acciones") return "/inversiones/brokerage/acciones";
  return "/inversiones/brokerage/crypto";
}

export function brokeragePortfolioGroupFromCategorySlug(categorySlug: string): BrokeragePortfolioGroup | null {
  if (categorySlug === "fintual_risky_norris") return "fondos_mutuos";
  if (categorySlug === "spy" || categorySlug === "vea") return "acciones";
  if (categorySlug === "bitcoin" || categorySlug === "eth") return "cripto";
  return null;
}

function accountIdToGroup(rows: AccountListRow[]): Map<number, BrokeragePortfolioGroup> {
  const m = new Map<number, BrokeragePortfolioGroup>();
  for (const r of rows) {
    const g = brokeragePortfolioGroupFromCategorySlug(r.category_slug);
    if (g) m.set(r.id, g);
  }
  return m;
}

export function addNullableNumbers(a: unknown, b: unknown): number | null {
  const na = typeof a === "number" && Number.isFinite(a) ? a : null;
  const nb = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (na == null && nb == null) return null;
  return (na ?? 0) + (nb ?? 0);
}

function accountCountsTowardGroupTotalsClient(a: TimeseriesAccountLine): boolean {
  return a.account_id <= 0 || !a.exclude_from_group_totals;
}

/** Same idea as server `appendGroupTabTotals`: prepend total valuation + optional total deposits. */
export function appendGroupTabTotalsClient(block: TimeseriesBlock): TimeseriesBlock {
  const src = block.accounts ?? [];
  if (src.length === 0 || block.points.length === 0) return block;
  if (src.length === 1) return block;

  const anyChildDep = src.some((a) => Boolean(a.depositDataKey));

  const points = block.points.map((row) => {
    let vSum = 0;
    let vAny = false;
    let dSum = 0;
    let dAny = false;
    for (const a of src) {
      if (!accountCountsTowardGroupTotalsClient(a)) continue;
      const v = row[a.dataKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        vSum += v;
        vAny = true;
      }
      if (a.depositDataKey) {
        const d = row[a.depositDataKey];
        if (typeof d === "number" && Number.isFinite(d)) {
          dSum += d;
          dAny = true;
        }
      }
    }
    const out: Record<string, string | number | null> = {
      ...row,
      [GROUP_TAB_VAL_TOTAL]: vAny ? vSum : null,
    };
    if (anyChildDep) {
      out[GROUP_TAB_DEP_TOTAL] = dAny ? dSum : null;
    }
    return out;
  });

  const totalLine: TimeseriesAccountLine = anyChildDep
    ? {
        account_id: -1,
        name: "Total (clase)",
        dataKey: GROUP_TAB_VAL_TOTAL,
        valueSeriesType: "reference",
        depositDataKey: GROUP_TAB_DEP_TOTAL,
        deposit_series_name: i18n.t("charts.groupAccumulatedDeposits"),
      }
    : {
        account_id: -1,
        name: "Total (clase)",
        dataKey: GROUP_TAB_VAL_TOTAL,
        valueSeriesType: "reference",
      };

  return {
    accounts: [totalLine, ...src],
    points,
    ...(block.lines?.length ? { lines: block.lines } : {}),
  };
}

/**
 * Brokerage “Todas”: collapse member accounts into Fondos mutuos / Acciones / Cripto for line + pie charts.
 */
export function aggregateBrokerageAllViewValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[]
): TimeseriesBlock {
  const idToGroup = accountIdToGroup(listRows);
  const members = (block.accounts ?? []).filter(
    (a) => a.account_id > 0 && !a.exclude_from_group_totals
  );
  if (members.length === 0) return block;

  const used = new Set<BrokeragePortfolioGroup>();
  for (const a of members) {
    const g = idToGroup.get(a.account_id);
    if (g) used.add(g);
  }
  if (used.size === 0) return block;

  const ordered: BrokeragePortfolioGroup[] = BROKERAGE_GROUP_ORDER.filter((g) => used.has(g));
  const synth: TimeseriesAccountLine[] = ordered.map((g) => {
    const m = G_META[g];
    return {
      account_id: m.accountId,
      name: brokeragePortfolioGroupLabel(g),
      dataKey: m.dataKey,
      valueSeriesType: "data",
      depositDataKey: m.depKey,
      deposit_series_name: i18n.t("charts.accumulatedDeposits"),
    };
  });

  const points = block.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const g of ordered) {
      const m = G_META[g];
      out[m.dataKey] = null;
      out[m.depKey] = null;
    }
    for (const a of members) {
      const g = idToGroup.get(a.account_id);
      if (!g) continue;
      const m = G_META[g];
      out[m.dataKey] = addNullableNumbers(out[m.dataKey], row[a.dataKey]);
      if (a.depositDataKey) {
        out[m.depKey] = addNullableNumbers(out[m.depKey], row[a.depositDataKey]);
      }
    }
    return out;
  });

  const base: TimeseriesBlock = {
    accounts: synth,
    points,
    ...(block.lines?.length ? { lines: block.lines } : {}),
  };
  return appendGroupTabTotalsClient(base);
}

export function aggregateBrokerageAllViewPie(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[]
): { name: string; account_id: number; value: number }[] {
  const idToGroup = accountIdToGroup(listRows);
  const sums = new Map<BrokeragePortfolioGroup, number>();
  const excluded = new Set(
    listRows.filter((r) => r.exclude_from_group_totals === 1).map((r) => r.id)
  );
  for (const s of pie) {
    if (excluded.has(s.account_id)) continue;
    const g = idToGroup.get(s.account_id);
    if (!g) continue;
    sums.set(g, (sums.get(g) ?? 0) + s.value);
  }
  const ordered: BrokeragePortfolioGroup[] = BROKERAGE_GROUP_ORDER.filter((g) => sums.has(g));
  return ordered.map((g) => ({
    name: brokeragePortfolioGroupLabel(g),
    account_id: G_META[g].accountId,
    value: sums.get(g) ?? 0,
  }));
}

export function aggregateBrokerageAllViewPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[]
): GroupMonthlyPerformanceResponse {
  const idToGroup = accountIdToGroup(listRows);
  const barById = new Map<number, GroupMonthlyPerformanceBarAccount>();
  for (const b of perf.bar_accounts) {
    barById.set(b.account_id, b);
  }

  const used = new Set<BrokeragePortfolioGroup>();
  for (const b of perf.bar_accounts) {
    const g = idToGroup.get(b.account_id);
    if (g) used.add(g);
  }
  if (used.size === 0) return perf;

  const ordered: BrokeragePortfolioGroup[] = BROKERAGE_GROUP_ORDER.filter((g) => used.has(g));
  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = ordered.map((g) => {
    const m = G_META[g];
    return {
      account_id: m.accountId,
      name: brokeragePortfolioGroupLabel(g),
      bar_data_key: m.barDataKey,
    };
  });

  const points = perf.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const g of ordered) {
      const m = G_META[g];
      const key = m.barDataKey;
      out[key] = null;
      let acc = 0;
      let any = false;
      for (const [id, grp] of idToGroup) {
        if (grp !== g) continue;
        const ba = barById.get(id);
        if (!ba) continue;
        const v = row[ba.bar_data_key];
        if (typeof v === "number" && Number.isFinite(v)) {
          acc += v;
          any = true;
        }
      }
      out[key] = any ? acc : null;
    }
    return out;
  });

  return {
    ...perf,
    bar_accounts,
    points,
  };
}
