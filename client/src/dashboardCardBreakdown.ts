import {
  BROKERAGE_GROUP_ORDER,
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  type BrokeragePortfolioGroup,
} from "./brokerageGroupedAggregation";
import i18n, { dashboardBucketLabel } from "./i18n";
import { brokerageAccountNavLabel, retirementAccountNavLabel } from "./navAccountLabels";
import type { AccountListRow, DashboardAccountRow, DepositFlowCategory } from "./types";

function asNavRow(a: DashboardAccountRow): AccountListRow {
  return {
    id: a.account_id,
    name: a.name,
    notes: a.notes ?? null,
    created_at: "",
    category_slug: a.category_slug,
    category_label: a.category_label,
    group_slug: a.group_slug,
    group_label: a.group_label,
  };
}

export type CardBreakdownLine = {
  label: string;
  clp: number;
  usd?: number | null;
  /** 0 = section; 1 = subgroup or category; 2 = leaf account / metric */
  depth: 0 | 1 | 2;
};

const NW_BUCKET_ORDER = ["real_estate", "retirement", "brokerage", "cash_eqs"] as const;

const DEPOSIT_CATEGORY_ORDER = ["real_estate", "cash", "brokerage", "inversiones"] as const;

function sumUsd(rows: DashboardAccountRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      sum += r.current_value_usd;
      any = true;
    }
  }
  return any ? sum : null;
}

function sumClp(rows: DashboardAccountRow[], pick: (r: DashboardAccountRow) => number): number {
  let s = 0;
  for (const r of rows) {
    s += pick(r);
  }
  return s;
}

function valueRows(accounts: DashboardAccountRow[]): DashboardAccountRow[] {
  return accounts.filter((a) => a.current_value_clp != null && Number.isFinite(a.current_value_clp));
}

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

function apvLeafKey(row: DashboardAccountRow): string {
  if (row.notes === "import:excel|key=apv_a_principal" || row.notes === "import:excel|key=apv_a") {
    return "apv-a";
  }
  if (row.notes === "import:excel|key=apv_b") return "apv-b";
  return retirementAccountNavLabel(asNavRow(row));
}

function flattenRetirementApv(apv: DashboardAccountRow[]): CardBreakdownLine[] {
  const byLeaf = new Map<string, DashboardAccountRow[]>();
  for (const r of apv) {
    const k = apvLeafKey(r);
    const list = byLeaf.get(k) ?? [];
    list.push(r);
    byLeaf.set(k, list);
  }
  const leaves = sortGroupsDesc(
    [...byLeaf.entries()].map(([label, rows]) => ({
      label,
      rows,
      clp: sumClp(rows, (r) => r.current_value_clp ?? 0),
      usd: sumUsd(rows),
    }))
  );
  const lines: CardBreakdownLine[] = [];
  const groupClp = sumClp(apv, (r) => r.current_value_clp ?? 0);
  const groupUsd = sumUsd(apv);
  lines.push({ label: i18n.t("retirement.apv"), clp: groupClp, usd: groupUsd, depth: 0 });
  for (const leaf of leaves) {
    lines.push({ label: leaf.label, clp: leaf.clp, usd: leaf.usd, depth: 1 });
  }
  return lines;
}

function flattenAfpAfc(afp: DashboardAccountRow[], afc: DashboardAccountRow[]): CardBreakdownLine[] {
  const lines: CardBreakdownLine[] = [];
  const all = [...afp, ...afc];
  const groupClp = sumClp(all, (r) => r.current_value_clp ?? 0);
  const groupUsd = sumUsd(all);
  lines.push({ label: i18n.t("retirement.afpAfc"), clp: groupClp, usd: groupUsd, depth: 0 });
  const children = sortGroupsDesc(
    all.map((r) => ({
      label: retirementAccountNavLabel(asNavRow(r)),
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
    }))
  );
  for (const c of children) {
    lines.push({ ...c, depth: 1 });
  }
  return lines;
}

/** Retirement card: APV and AFP + AFC (nav order), each sorted by amount among top-level groups. */
export function buildRetirementCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const ret = valueRows(accounts.filter((a) => a.group_slug === "retirement"));
  const apv = ret.filter((a) => a.category_slug === "apv");
  const afp = ret.filter((a) => a.category_slug === "afp");
  const afc = ret.filter((a) => a.category_slug === "afc");

  const groups: { clp: number; lines: CardBreakdownLine[] }[] = [];
  if (apv.length) groups.push({ clp: sumClp(apv, (r) => r.current_value_clp ?? 0), lines: flattenRetirementApv(apv) });
  if (afp.length || afc.length) {
    groups.push({
      clp: sumClp([...afp, ...afc], (r) => r.current_value_clp ?? 0),
      lines: flattenAfpAfc(afp, afc),
    });
  }
  return sortGroupsDesc(groups).flatMap((g) => g.lines);
}

/** Brokerage card: mutual funds / equities / crypto subgroups with account leaves (active only). */
export function buildBrokerageCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const bro = valueRows(accounts.filter((a) => a.group_slug === "brokerage"));
  const byGroup = new Map<BrokeragePortfolioGroup, DashboardAccountRow[]>();
  for (const r of bro) {
    const g = brokeragePortfolioGroupFromCategorySlug(r.category_slug);
    if (!g) continue;
    const list = byGroup.get(g) ?? [];
    list.push(r);
    byGroup.set(g, list);
  }

  const groupBlocks = BROKERAGE_GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
    const rows = byGroup.get(g)!;
    const clp = sumClp(rows, (r) => r.current_value_clp ?? 0);
    const usd = sumUsd(rows);
    const children = sortGroupsDesc(
      rows.map((r) => ({
        label: brokerageAccountNavLabel(asNavRow(r)),
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
      }))
    );
    const lines: CardBreakdownLine[] = [
      { label: brokeragePortfolioGroupLabel(g), clp, usd, depth: 0 },
      ...children.map((c) => ({ ...c, depth: 1 as const })),
    ];
    return { clp, lines };
  });

  return sortGroupsDesc(groupBlocks).flatMap((b) => b.lines);
}

/** Net worth card: RE, retirement, brokerage, cash (assets ex liabilities). */
export function buildNetWorthCardBreakdown(totals: {
  real_estate_clp: number;
  retirement_clp: number;
  brokerage_clp: number;
  cash_eqs_clp: number;
  real_estate_usd?: number;
  retirement_usd?: number;
  brokerage_usd?: number;
  cash_eqs_usd?: number;
}): CardBreakdownLine[] {
  const rows = NW_BUCKET_ORDER.map((key) => {
    const clpKey = `${key}_clp` as const;
    const usdKey = `${key}_usd` as const;
    return {
      label: dashboardBucketLabel(key),
      clp: totals[clpKey],
      usd: totals[usdKey],
    };
  });
  return sortGroupsDesc(rows).map((r) => ({ ...r, depth: 0 as const }));
}

export type SueciaSnapshot = {
  valor_clp: number;
  net_value_clp: number;
  mortgage_clp: number;
  valor_usd?: number | null;
  net_value_usd?: number | null;
  mortgage_usd?: number | null;
};

/** Real estate card: Suecia (net) with valor and mortgage detail lines. */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  suecia: SueciaSnapshot | null | undefined
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (!suecia && props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const propertyName = props[0]?.name.trim().toLowerCase() ?? "suecia";
  const netFromAccount = props.length ? sumClp(props, (r) => r.current_value_clp ?? 0) : null;
  const netClp = suecia?.net_value_clp ?? netFromAccount ?? 0;
  const groupUsd = props.length ? sumUsd(props) : null;

  lines.push({ label: propertyName, clp: netClp, usd: groupUsd, depth: 0 });

  if (suecia) {
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: suecia.valor_clp,
      usd: suecia.valor_usd,
      depth: 1,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: suecia.mortgage_clp,
      usd: suecia.mortgage_usd,
      depth: 1,
    });
  } else if (props.length) {
    for (const r of props) {
      lines.push({
        label: r.name,
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        depth: 1,
      });
    }
  }
  return lines;
}

const CASH_CARD_SLUGS = new Set(["fondo_reserva", "cuenta_corriente"]);
const CASH_CATEGORY_KEYS: Record<string, string> = {
  fondo_reserva: "cash.reserva",
  cuenta_corriente: "cash.checkingAccount",
};

/** Cash card: reserva and cuenta corriente (active accounts only). */
export function buildCashCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const cash = valueRows(
    accounts.filter((a) => a.group_slug === "cash_eqs" && CASH_CARD_SLUGS.has(a.category_slug))
  );
  return sortGroupsDesc(
    cash.map((r) => ({
      label: CASH_CATEGORY_KEYS[r.category_slug]
        ? i18n.t(CASH_CATEGORY_KEYS[r.category_slug]!)
        : r.name,
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

const LIABILITY_KEYS = {
  mortgage: "liabilities.mortgage",
  credit_card: "liabilities.creditCard",
} as const;

/** Liabilities card: mortgage and credit card (aligned with dashboard liabilities total). */
export function buildLiabilitiesCardBreakdown(breakdown: {
  mortgage_clp: number;
  credit_card_clp: number;
  mortgage_usd?: number | null;
  credit_card_usd?: number | null;
}): CardBreakdownLine[] {
  const rows = (
    [
      {
        key: "mortgage" as const,
        clp: breakdown.mortgage_clp,
        usd: breakdown.mortgage_usd,
      },
      {
        key: "credit_card" as const,
        clp: breakdown.credit_card_clp,
        usd: breakdown.credit_card_usd,
      },
    ] as const
  ).filter((r) => r.clp > 0);
  return sortGroupsDesc(
    rows.map((r) => ({
      label: i18n.t(LIABILITY_KEYS[r.key]),
      clp: r.clp,
      usd: r.usd,
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

/** Deposits card: per-category totals (USD = sum of each event at its deposit-date FX). */
export function buildDepositsCardBreakdown(
  byCategory:
    | Partial<Record<DepositFlowCategory, { label: string; total_clp: number; total_usd: number }>>
    | undefined
): CardBreakdownLine[] {
  if (!byCategory) return [];
  return DEPOSIT_CATEGORY_ORDER.filter((c) => byCategory[c])
    .map((c) => {
      const block = byCategory[c]!;
      return {
        label: block.label,
        clp: block.total_clp,
        usd: block.total_usd,
      };
    })
    .filter((g) => g.clp !== 0)
    .sort((a, b) => Math.abs(b.clp) - Math.abs(a.clp))
    .map((g) => ({ ...g, depth: 0 as const }));
}
