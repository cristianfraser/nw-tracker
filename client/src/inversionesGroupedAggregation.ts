import type {
  AccountListRow,
  GroupMonthlyPerformanceBarAccount,
  GroupMonthlyPerformanceResponse,
  TimeseriesAccountLine,
  TimeseriesBlock,
} from "./types";
import {
  addNullableNumbers,
  appendGroupTabTotalsClient,
  brokeragePortfolioGroupFromCategorySlug,
} from "./brokerageGroupedAggregation";

/** Inversiones root — Agrupado: Brokerage vs Retiro. */
const ROOT_GRP_ORDER = ["brokerage", "retiro"] as const;
type RootGrp = (typeof ROOT_GRP_ORDER)[number];
const ROOT_GRP_META: Record<
  RootGrp,
  { accountId: number; dataKey: string; depKey: string; barDataKey: string; name: string }
> = {
  brokerage: {
    accountId: -601,
    dataKey: "inv_r_brk",
    depKey: "inv_r_brk_dep",
    barDataKey: "pl_inv_r_brk",
    name: "Brokerage",
  },
  retiro: {
    accountId: -602,
    dataKey: "inv_r_ret",
    depKey: "inv_r_ret_dep",
    barDataKey: "pl_inv_r_ret",
    name: "Retiro",
  },
};

/** Inversiones root — sin agrupar: sub-clases (AFP y AFC van juntos, alineado con la jerarquía Retiro → AFP + AFC). */
const ROOT_UNG_ORDER = ["mutual_funds", "acciones", "cripto", "afp_afc", "apv"] as const;
type RootUngrouped = (typeof ROOT_UNG_ORDER)[number];
const ROOT_UNG_META: Record<
  RootUngrouped,
  { accountId: number; dataKey: string; depKey: string; barDataKey: string; name: string }
> = {
  mutual_funds: {
    accountId: -611,
    dataKey: "inv_u_fm",
    depKey: "inv_u_fm_dep",
    barDataKey: "pl_inv_u_fm",
    name: "Mutual funds",
  },
  acciones: {
    accountId: -612,
    dataKey: "inv_u_eq",
    depKey: "inv_u_eq_dep",
    barDataKey: "pl_inv_u_eq",
    name: "Acciones",
  },
  cripto: {
    accountId: -613,
    dataKey: "inv_u_cr",
    depKey: "inv_u_cr_dep",
    barDataKey: "pl_inv_u_cr",
    name: "Cripto",
  },
  afp_afc: {
    accountId: -614,
    dataKey: "inv_u_afp_afc",
    depKey: "inv_u_afp_afc_dep",
    barDataKey: "pl_inv_u_afp_afc",
    name: "AFP + AFC",
  },
  apv: {
    accountId: -615,
    dataKey: "inv_u_apv",
    depKey: "inv_u_apv_dep",
    barDataKey: "pl_inv_u_apv",
    name: "APV",
  },
};

/** Retiro — Agrupado: AFP / APV / AFC. */
const RET_GRP_ORDER = ["afp", "apv", "afc"] as const;
type RetGrp = (typeof RET_GRP_ORDER)[number];
const RET_GRP_META: Record<
  RetGrp,
  { accountId: number; dataKey: string; depKey: string; barDataKey: string; name: string }
> = {
  afp: {
    accountId: -701,
    dataKey: "ret_g_afp",
    depKey: "ret_g_afp_dep",
    barDataKey: "pl_ret_g_afp",
    name: "AFP",
  },
  apv: {
    accountId: -702,
    dataKey: "ret_g_apv",
    depKey: "ret_g_apv_dep",
    barDataKey: "pl_ret_g_apv",
    name: "APV",
  },
  afc: {
    accountId: -703,
    dataKey: "ret_g_afc",
    depKey: "ret_g_afc_dep",
    barDataKey: "pl_ret_g_afc",
    name: "AFC",
  },
};

function rootGroupedBucket(row: AccountListRow): RootGrp | null {
  if (row.group_slug === "brokerage") return "brokerage";
  if (row.group_slug === "retirement") return "retiro";
  return null;
}

function rootUngroupedBucket(row: AccountListRow): RootUngrouped | null {
  if (row.group_slug === "brokerage") {
    const g = brokeragePortfolioGroupFromCategorySlug(row.category_slug);
    if (g) return g;
    return null;
  }
  if (row.group_slug === "retirement") {
    if (row.category_slug === "afp" || row.category_slug === "afc") return "afp_afc";
    if (row.category_slug === "apv") return "apv";
  }
  return null;
}

function retiroGroupedBucket(row: AccountListRow): RetGrp | null {
  if (row.group_slug !== "retirement") return null;
  if (row.category_slug === "afp") return "afp";
  if (row.category_slug === "apv") return "apv";
  if (row.category_slug === "afc") return "afc";
  return null;
}

function buildIdToBucket<K extends string>(
  listRows: AccountListRow[],
  rowToBucket: (row: AccountListRow) => K | null
): (id: number) => K | null {
  const m = new Map<number, K>();
  for (const r of listRows) {
    const b = rowToBucket(r);
    if (b) m.set(r.id, b);
  }
  return (id) => m.get(id) ?? null;
}

function aggregateValuationByBucket<K extends string>(
  block: TimeseriesBlock,
  orderedKeys: readonly K[],
  meta: Record<K, { accountId: number; dataKey: string; depKey: string; barDataKey: string; name: string }>,
  idToBucket: (id: number) => K | null
): TimeseriesBlock {
  const members = (block.accounts ?? []).filter(
    (a) => a.account_id > 0 && !a.exclude_from_group_totals
  );
  if (members.length === 0) return block;

  const used = new Set<K>();
  for (const a of members) {
    const b = idToBucket(a.account_id);
    if (b) used.add(b);
  }
  if (used.size === 0) return block;

  const ordered = orderedKeys.filter((k) => used.has(k));
  const synth: TimeseriesAccountLine[] = ordered.map((k) => {
    const m = meta[k]!;
    return {
      account_id: m.accountId,
      name: m.name,
      dataKey: m.dataKey,
      valueSeriesType: "data",
      depositDataKey: m.depKey,
      deposit_series_name: "aportes acum.",
    };
  });

  const points = block.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const k of ordered) {
      const m = meta[k]!;
      out[m.dataKey] = null;
      out[m.depKey] = null;
    }
    for (const a of members) {
      const b = idToBucket(a.account_id);
      if (!b) continue;
      const m = meta[b]!;
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

function aggregatePieByBucket<K extends string>(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[],
  orderedKeys: readonly K[],
  meta: Record<K, { accountId: number; name: string }>,
  rowToBucket: (row: AccountListRow) => K | null
): { name: string; account_id: number; value: number }[] {
  const idToRow = new Map(listRows.map((r) => [r.id, r]));
  const sums = new Map<K, number>();
  for (const s of pie) {
    const row = idToRow.get(s.account_id);
    if (!row) continue;
    if (row.exclude_from_group_totals === 1) continue;
    const b = rowToBucket(row);
    if (!b) continue;
    sums.set(b, (sums.get(b) ?? 0) + s.value);
  }
  const ordered = orderedKeys.filter((k) => sums.has(k));
  return ordered.map((k) => ({
    name: meta[k]!.name,
    account_id: meta[k]!.accountId,
    value: sums.get(k) ?? 0,
  }));
}

function aggregatePerformanceByBucket<K extends string>(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[],
  orderedKeys: readonly K[],
  meta: Record<K, { accountId: number; name: string; barDataKey: string }>,
  rowToBucket: (row: AccountListRow) => K | null
): GroupMonthlyPerformanceResponse {
  const barById = new Map<number, GroupMonthlyPerformanceBarAccount>();
  for (const b of perf.bar_accounts) {
    barById.set(b.account_id, b);
  }
  const idToRow = new Map(listRows.map((r) => [r.id, r]));

  const used = new Set<K>();
  for (const b of perf.bar_accounts) {
    const row = idToRow.get(b.account_id);
    if (!row) continue;
    const k = rowToBucket(row);
    if (k) used.add(k);
  }
  if (used.size === 0) return perf;

  const ordered = orderedKeys.filter((k) => used.has(k));
  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = ordered.map((k) => {
    const m = meta[k]!;
    return { account_id: m.accountId, name: m.name, bar_data_key: m.barDataKey };
  });

  const points = perf.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const k of ordered) {
      const m = meta[k]!;
      out[m.barDataKey] = null;
      let acc = 0;
      let any = false;
      for (const r of listRows) {
        if (rowToBucket(r) !== k) continue;
        const ba = barById.get(r.id);
        if (!ba) continue;
        const v = row[ba.bar_data_key];
        if (typeof v === "number" && Number.isFinite(v)) {
          acc += v;
          any = true;
        }
      }
      out[m.barDataKey] = any ? acc : null;
    }
    return out;
  });

  return { ...perf, bar_accounts, points };
}

export function aggregateInversionesRootGroupedValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[]
): TimeseriesBlock {
  return aggregateValuationByBucket(block, ROOT_GRP_ORDER, ROOT_GRP_META, buildIdToBucket(listRows, rootGroupedBucket));
}

export function aggregateInversionesRootGroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[]
): { name: string; account_id: number; value: number }[] {
  return aggregatePieByBucket(pie, listRows, ROOT_GRP_ORDER, ROOT_GRP_META, rootGroupedBucket);
}

export function aggregateInversionesRootGroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[]
): GroupMonthlyPerformanceResponse {
  return aggregatePerformanceByBucket(perf, listRows, ROOT_GRP_ORDER, ROOT_GRP_META, rootGroupedBucket);
}

export function aggregateInversionesRootUngroupedValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[]
): TimeseriesBlock {
  return aggregateValuationByBucket(
    block,
    ROOT_UNG_ORDER,
    ROOT_UNG_META,
    buildIdToBucket(listRows, rootUngroupedBucket)
  );
}

export function aggregateInversionesRootUngroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[]
): { name: string; account_id: number; value: number }[] {
  return aggregatePieByBucket(pie, listRows, ROOT_UNG_ORDER, ROOT_UNG_META, rootUngroupedBucket);
}

export function aggregateInversionesRootUngroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[]
): GroupMonthlyPerformanceResponse {
  return aggregatePerformanceByBucket(perf, listRows, ROOT_UNG_ORDER, ROOT_UNG_META, rootUngroupedBucket);
}

export function aggregateRetiroGroupedValuationBlock(block: TimeseriesBlock, listRows: AccountListRow[]): TimeseriesBlock {
  return aggregateValuationByBucket(block, RET_GRP_ORDER, RET_GRP_META, buildIdToBucket(listRows, retiroGroupedBucket));
}

export function aggregateRetiroGroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[]
): { name: string; account_id: number; value: number }[] {
  return aggregatePieByBucket(pie, listRows, RET_GRP_ORDER, RET_GRP_META, retiroGroupedBucket);
}

export function aggregateRetiroGroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[]
): GroupMonthlyPerformanceResponse {
  return aggregatePerformanceByBucket(perf, listRows, RET_GRP_ORDER, RET_GRP_META, retiroGroupedBucket);
}

/** APV class tab (`subgroup=apv`): Agrupado — régimen A (principal + Fintual) vs régimen B. */
const APV_LEAF_SUBGROUP_ORDER = ["apv_a_leg", "apv_b_leg"] as const;
type ApvLeafSubgroup = (typeof APV_LEAF_SUBGROUP_ORDER)[number];

const APV_LEAF_SUBGROUP_META: Record<
  ApvLeafSubgroup,
  { accountId: number; dataKey: string; depKey: string; barDataKey: string; name: string }
> = {
  apv_a_leg: {
    accountId: -801,
    dataKey: "apv_leaf_a",
    depKey: "apv_leaf_a_dep",
    barDataKey: "pl_apv_leaf_a",
    name: "APV régimen A",
  },
  apv_b_leg: {
    accountId: -802,
    dataKey: "apv_leaf_b",
    depKey: "apv_leaf_b_dep",
    barDataKey: "pl_apv_leaf_b",
    name: "APV régimen B",
  },
};

function apvLeafSubgroupBucket(row: AccountListRow): ApvLeafSubgroup | null {
  if (row.category_slug !== "apv") return null;
  if (row.notes === "import:excel|key=apv_b") return "apv_b_leg";
  if (row.notes === "import:excel|key=apv_a" || row.notes === "import:excel|key=apv_a_principal") {
    return "apv_a_leg";
  }
  return null;
}

export function aggregateApvSubgroupGroupedValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[]
): TimeseriesBlock {
  return aggregateValuationByBucket(
    block,
    APV_LEAF_SUBGROUP_ORDER,
    APV_LEAF_SUBGROUP_META,
    buildIdToBucket(listRows, apvLeafSubgroupBucket)
  );
}

export function aggregateApvSubgroupGroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  listRows: AccountListRow[]
): { name: string; account_id: number; value: number }[] {
  return aggregatePieByBucket(pie, listRows, APV_LEAF_SUBGROUP_ORDER, APV_LEAF_SUBGROUP_META, apvLeafSubgroupBucket);
}

export function aggregateApvSubgroupGroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[]
): GroupMonthlyPerformanceResponse {
  return aggregatePerformanceByBucket(
    perf,
    listRows,
    APV_LEAF_SUBGROUP_ORDER,
    APV_LEAF_SUBGROUP_META,
    apvLeafSubgroupBucket
  );
}
