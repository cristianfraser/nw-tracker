import type { TimeseriesBlock } from "./types";

function seriesKeysForAccount(line: {
  dataKey: string;
  depositDataKey?: string;
}): string[] {
  const keys = [line.dataKey];
  if (line.depositDataKey) keys.push(line.depositDataKey);
  return keys;
}

/** Linked-group overlays from `portfolio_groups` (`ref:…` dataKeys), not class totals like `__group_val_total`. */
function isChartReferenceLine(line: { dataKey: string }): boolean {
  return line.dataKey.startsWith("ref:");
}

/** Synthetic class total from `appendGroupTabTotals` (always kept on filtered subgroup tabs). */
function isGroupTabTotalLine(line: { dataKey: string }): boolean {
  return line.dataKey === "__group_val_total" || line.dataKey === "__group_dep_total";
}

/** Restrict a class-tab valuation block to a subset of accounts (e.g. Pasivos → tarjeta de crédito). */
export function filterTimeseriesBlockByAccountIds(
  block: TimeseriesBlock | undefined | null,
  accountIds: Set<number>
): TimeseriesBlock | null {
  if (!block) return null;
  const dataAccounts = (block.accounts ?? []).filter(
    (a) =>
      !isChartReferenceLine(a) &&
      (isGroupTabTotalLine(a) || accountIds.has(a.account_id))
  );
  /** Reference overlays are charted from `lines` only (see server `appendChartHostReferenceOverlays`). */
  const accounts = dataAccounts;
  const refLines = (block.lines ?? []).filter((l) => isChartReferenceLine({ dataKey: l.dataKey }));
  if (!dataAccounts.length && !refLines.length) {
    return { accounts: [], lines: [], points: block.points.map((p) => ({ as_of_date: p.as_of_date })) };
  }

  const keepKeys = new Set<string>();
  for (const a of accounts) {
    for (const k of seriesKeysForAccount(a)) keepKeys.add(k);
  }
  for (const l of refLines) keepKeys.add(l.dataKey);

  const lines = (block.lines ?? []).filter((l) => keepKeys.has(l.dataKey));
  const points = block.points.map((row) => {
    const out: Record<string, string | number | null> = { as_of_date: row.as_of_date };
    for (const k of keepKeys) {
      if (k in row) out[k] = row[k] ?? null;
    }
    return out;
  });

  return { accounts, lines, points, synthetic_group_color_rgb: block.synthetic_group_color_rgb };
}
