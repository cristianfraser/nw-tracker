import { buildProportionalFromValueArrays, type ProportionalSeriesBlock } from "./proportionalSeries.js";
import { getNetWorthNavGroupNode, type NavTreeNodeDto } from "./navTree.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { cashNetOfLinkedCreditCards } from "./cashEqsBucketNet.js";
import { slugMarkTotalsAtDatesClp, type ChartMarkTotalAccountRow } from "./dashboardChartMarkTotals.js";
import { isCashSavingsNavNode } from "./dashboardNavCardMetrics.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";

/**
 * Home composition chart: 100%-stacked shares one level below the "big" buckets of the
 * net_worth nav tree. Everything — which buckets, which lines, labels, colours, stack order —
 * comes from the tree; nothing here names a slug except through `isCashSavingsNavNode`, the
 * rule that already attaches the linked credit-card netting to the savings node.
 */

function isGroupNode(n: NavTreeNodeDto): boolean {
  return (
    n.account_id == null &&
    n.expense_account_id == null &&
    (n.group_kind === "bucket" || n.group_kind === "nav_bucket")
  );
}

/**
 * The "big" buckets: net_worth's children, where a `nav_bucket` without a
 * `dashboard_bucket_slug` (a pure sidebar grouping such as Inversiones) is replaced by its own
 * children. Liability and reference groups are not assets and are skipped.
 */
export function compositionBigBuckets(root: NavTreeNodeDto): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  for (const child of root.children ?? []) {
    if (child.group_kind === "liability_group" || child.group_kind === "reference") continue;
    if (!isGroupNode(child)) continue;
    if (child.group_kind === "nav_bucket" && !child.dashboard_bucket_slug?.trim()) {
      out.push(...compositionBigBuckets(child));
      continue;
    }
    out.push(child);
  }
  return out;
}

/** An account row as the group-tab listing returns it (the fields the marks need). */
export type CompositionAccountRow = ChartMarkTotalAccountRow;

export type CompositionLineSpec = {
  /** Group slug, or `account_<id>` for a direct account (the nav node's slug). */
  dataKey: string;
  bigBucketSlug: string;
  name: string;
  name_i18n_key: string | null;
  color_rgb: string | null;
  rows: CompositionAccountRow[];
  /** Subtract the linked credit cards' owed total (the savings node, as the cash card does). */
  netLinkedCreditCard: boolean;
};

/**
 * One line per first-level child of each big bucket (child groups: Σ of their accounts; direct
 * accounts: one line each), in nav order, grouped by big bucket. `rowsForGroup` resolves a
 * group's accounts the way the dashboard marks do (`listAccountsForGroupTab`).
 */
export function buildCompositionLineSpecs(
  root: NavTreeNodeDto,
  rowsForGroup: (groupSlug: string) => readonly CompositionAccountRow[]
): CompositionLineSpec[] {
  const specs: CompositionLineSpec[] = [];
  const seenAccounts = new Map<number, string>();
  const claim = (rows: readonly CompositionAccountRow[], key: string) => {
    for (const r of rows) {
      const prior = seenAccounts.get(r.account_id);
      if (prior != null) {
        throw new Error(`composition: account ${r.account_id} is in both "${prior}" and "${key}"`);
      }
      seenAccounts.set(r.account_id, key);
    }
  };

  for (const big of compositionBigBuckets(root)) {
    const bucketRows = rowsForGroup(big.slug).filter((r) => r.account_id > 0);
    const kids = (big.children ?? []).filter(
      (c) => isGroupNode(c) || (c.account_id != null && c.account_id > 0)
    );
    if (kids.length === 0) {
      claim(bucketRows, big.slug);
      specs.push({
        dataKey: big.slug,
        bigBucketSlug: big.slug,
        name: big.label,
        name_i18n_key: big.label_i18n_key,
        color_rgb: big.color_rgb,
        rows: bucketRows,
        netLinkedCreditCard: isCashSavingsNavNode(big),
      });
      continue;
    }
    for (const kid of kids) {
      let rows: CompositionAccountRow[];
      if (kid.account_id != null) {
        const row = bucketRows.find((r) => r.account_id === kid.account_id);
        if (!row) {
          throw new Error(`composition: account ${kid.account_id} is not among "${big.slug}" rows`);
        }
        rows = [row];
      } else {
        rows = rowsForGroup(kid.slug).filter((r) => r.account_id > 0);
      }
      claim(rows, kid.slug);
      specs.push({
        dataKey: kid.slug,
        bigBucketSlug: big.slug,
        name: kid.label,
        name_i18n_key: kid.label_i18n_key,
        color_rgb: kid.color_rgb,
        rows,
        netLinkedCreditCard: kid.account_id == null && isCashSavingsNavNode(kid),
      });
    }
  }

  // Σ of a bucket's lines must be the bucket: an account the lines skip would vanish from the chart.
  for (const big of compositionBigBuckets(root)) {
    const covered = new Set(
      specs.filter((s) => s.bigBucketSlug === big.slug).flatMap((s) => s.rows.map((r) => r.account_id))
    );
    for (const r of rowsForGroup(big.slug)) {
      if (r.account_id > 0 && r.exclude_from_group_totals !== 1 && !covered.has(r.account_id)) {
        throw new Error(`composition: account ${r.account_id} of "${big.slug}" is in none of its lines`);
      }
    }
  }
  if (specs.filter((s) => s.netLinkedCreditCard).length !== 1) {
    throw new Error("composition: exactly one line must carry the linked credit-card netting");
  }
  const keys = new Set(specs.map((s) => s.dataKey));
  if (keys.size !== specs.length) throw new Error("composition: duplicate line key");
  return specs;
}

/** The specs of the live net_worth tree. */
export function compositionLineSpecsFromNavTree(
  rowsForGroup: (groupSlug: string) => readonly CompositionAccountRow[]
): CompositionLineSpec[] {
  const root = getNetWorthNavGroupNode();
  if (!root) throw new Error("composition: net_worth nav tree missing");
  return buildCompositionLineSpecs(root, rowsForGroup);
}

/**
 * Monthly values (CLP) at the chart dates: Σ marks per line at those dates only. `reuse` lends
 * totals the caller already computed for the same group (same rows, no netting).
 */
export function compositionValuesAtDatesClp(
  specs: readonly CompositionLineSpec[],
  datesAsc: readonly string[],
  reuse?: ReadonlyMap<string, ReadonlyMap<string, number>>
): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>();
  for (const spec of specs) {
    const reusable = !spec.netLinkedCreditCard ? reuse?.get(spec.dataKey) : undefined;
    const totals =
      reusable ??
      slugMarkTotalsAtDatesClp(spec.rows, datesAsc, { netLinkedCreditCard: spec.netLinkedCreditCard });
    out.set(spec.dataKey, datesAsc.map((d) => totals.get(d) ?? null));
  }
  return out;
}

/**
 * Daily values (CLP) on a contiguous Chile-day grid from the per-account mark cache. Same rules
 * as the monthly totals: a day with no finite mark is null (except the netted line, which
 * always reads), per-day rounding after the netting.
 */
export function compositionValuesOnGridClp(
  specs: readonly CompositionLineSpec[],
  grid: readonly string[]
): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>();
  for (const spec of specs) {
    const marks = spec.rows
      .filter((r) => r.exclude_from_group_totals !== 1)
      .map((a) =>
        accountMarkClpSeriesOnGrid(
          { account_id: a.account_id, bucket_slug: a.bucket_slug, import_key: a.import_key ?? null, name: a.name ?? null },
          grid
        )
      );
    out.set(
      spec.dataKey,
      grid.map((ymd, gi) => {
        let raw = 0;
        let any = false;
        for (const m of marks) {
          const v = m[gi];
          if (v != null && Number.isFinite(v)) {
            raw += v;
            any = true;
          }
        }
        if (spec.netLinkedCreditCard) {
          return Math.round(cashNetOfLinkedCreditCards(raw, linkedCreditCardClpForCashCardAsOf(ymd)));
        }
        return any ? Math.round(raw) : null;
      })
    );
  }
  return out;
}

/**
 * Shares per line on `dates`. Lines stack in spec order (bottom to top), i.e. grouped by big
 * bucket in nav order. Shares are unit-invariant (every line converts at the same rate), so the
 * CLP values serve both display units.
 */
export function buildCompositionBlock(
  dates: readonly string[],
  specs: readonly CompositionLineSpec[],
  valuesByKey: ReadonlyMap<string, readonly (number | null)[]>
): ProportionalSeriesBlock {
  return buildProportionalFromValueArrays(
    dates,
    specs.map((s) => {
      const values = valuesByKey.get(s.dataKey);
      if (!values) throw new Error(`composition: no values for line "${s.dataKey}"`);
      return {
        dataKey: s.dataKey,
        name: s.name,
        ...(s.name_i18n_key != null ? { name_i18n_key: s.name_i18n_key } : {}),
        ...(s.color_rgb != null ? { color_rgb: s.color_rgb } : {}),
        values,
      };
    })
  );
}
