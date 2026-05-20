import { db } from "./db.js";

/** Stored as `r,g,b` integers 0–255. */
export type RgbTriplet = `${number},${number},${number}` | string;

export function parseRgbTriplet(raw: string | null | undefined): [number, number, number] | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function rgbTripletToCss(raw: string | null | undefined, fallback = "#94a3b8"): string {
  const p = parseRgbTriplet(raw);
  if (!p) return fallback;
  return `rgb(${p[0]},${p[1]},${p[2]})`;
}

export function averageRgbTriplets(triplets: string[]): string | null {
  const parsed = triplets.map(parseRgbTriplet).filter((p): p is [number, number, number] => p != null);
  if (parsed.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [pr, pg, pb] of parsed) {
    r += pr;
    g += pg;
    b += pb;
  }
  const n = parsed.length;
  return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
}

/** Stable pleasant RGB for new accounts without an explicit color. */
export function prettyRgbTripletForAccountId(accountId: number): string {
  return `${72 + ((accountId * 73) % 156)},${72 + ((accountId * 47) % 156)},${72 + ((accountId * 91) % 156)}`;
}

const accountColorStmt = db.prepare(`SELECT color_rgb FROM accounts WHERE id = ?`);

export function getAccountColorRgb(accountId: number): string {
  const row = accountColorStmt.get(accountId) as { color_rgb: string | null } | undefined;
  if (row?.color_rgb) return row.color_rgb;
  return prettyRgbTripletForAccountId(accountId);
}

type PortfolioGroupRow = {
  id: number;
  slug: string;
  color_rgb: string | null;
};

const groupBySlugStmt = db.prepare(
  `SELECT id, slug, color_rgb FROM portfolio_groups WHERE slug = ?`
);

const groupItemsStmt = db.prepare(
  `SELECT item_kind, child_group_id, account_id
   FROM portfolio_group_items
   WHERE group_id = ?
   ORDER BY sort_order, id`
);

const resolvedGroupColorCache = new Map<number, string>();

/** Explicit group color, else RGB average of direct child accounts and child groups. */
export function resolvePortfolioGroupColorRgb(groupId: number): string {
  const cached = resolvedGroupColorCache.get(groupId);
  if (cached) return cached;

  const group = db
    .prepare(`SELECT id, slug, color_rgb FROM portfolio_groups WHERE id = ?`)
    .get(groupId) as PortfolioGroupRow | undefined;
  if (!group) return "148,163,184";

  if (group.color_rgb) {
    resolvedGroupColorCache.set(groupId, group.color_rgb);
    return group.color_rgb;
  }

  const items = groupItemsStmt.all(groupId) as {
    item_kind: "group" | "account";
    child_group_id: number | null;
    account_id: number | null;
  }[];

  const childColors: string[] = [];
  for (const item of items) {
    if (item.item_kind === "account" && item.account_id != null) {
      childColors.push(getAccountColorRgb(item.account_id));
    } else if (item.item_kind === "group" && item.child_group_id != null) {
      childColors.push(resolvePortfolioGroupColorRgb(item.child_group_id));
    }
  }

  const avg = averageRgbTriplets(childColors) ?? "148,163,184";
  resolvedGroupColorCache.set(groupId, avg);
  return avg;
}

export function resolvePortfolioGroupColorRgbBySlug(slug: string): string | null {
  const row = groupBySlugStmt.get(slug) as PortfolioGroupRow | undefined;
  if (!row) return null;
  return resolvePortfolioGroupColorRgb(row.id);
}

/**
 * Colors for client-side synthetic account lines (negative ids) used when aggregating charts.
 * Keys are stringified account ids (e.g. `"-203"`). Prefer these over averaging member account colors.
 */
export function syntheticGroupColorRgbMapForValuationGroup(groupSlug: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (accountId: number, portfolioGroupSlug: string) => {
    const c = resolvePortfolioGroupColorRgbBySlug(portfolioGroupSlug);
    if (c) out[String(accountId)] = c;
  };

  switch (groupSlug) {
    case "brokerage":
      add(-201, "brokerage_mutual_funds");
      add(-202, "brokerage_acciones");
      add(-203, "brokerage_crypto");
      break;
    case "inversiones":
      add(-601, "brokerage");
      add(-602, "retirement");
      add(-611, "brokerage_mutual_funds");
      add(-612, "brokerage_acciones");
      add(-613, "brokerage_crypto");
      add(-614, "retirement_afp_afc");
      add(-615, "retirement_apv");
      break;
    case "retirement":
      add(-701, "retirement_afp");
      add(-702, "retirement_apv");
      add(-703, "retirement_afc");
      add(-801, "retirement_apv_a");
      add(-802, "retirement_apv_b");
      break;
    default:
      break;
  }

  return out;
}

export function clearPortfolioGroupColorCache(): void {
  resolvedGroupColorCache.clear();
}

/** Attach `color_rgb` to valuation / timeseries account lines (positive account ids only). */
export function colorRgbForTimeseriesAccountLine(accountId: number): string | undefined {
  if (accountId <= 0) return undefined;
  return getAccountColorRgb(accountId);
}

const accountColorByNoteStmt = db.prepare(
  `SELECT color_rgb FROM accounts WHERE notes = ? LIMIT 1`
);

function getAccountColorRgbByImportNote(note: string): string | null {
  const row = accountColorByNoteStmt.get(note) as { color_rgb: string | null } | undefined;
  return row?.color_rgb ?? null;
}

/** Synthetic brokerage subgroup lines (`aggregateBrokerageAllViewValuationBlock`). */
export function colorRgbForSyntheticAccountLine(accountId: number): string | undefined {
  switch (accountId) {
    case -201:
      return resolvePortfolioGroupColorRgbBySlug("brokerage_mutual_funds") ?? undefined;
    case -202:
      return resolvePortfolioGroupColorRgbBySlug("brokerage_acciones") ?? undefined;
    case -203:
      return resolvePortfolioGroupColorRgbBySlug("brokerage_crypto") ?? undefined;
    case -9101: {
      const avg = averageRgbTriplets(
        ["import:excel|key=afp", "import:excel|key=afc"]
          .map(getAccountColorRgbByImportNote)
          .filter((c): c is string => c != null)
      );
      return avg ?? undefined;
    }
    case -9102: {
      const avg = averageRgbTriplets(
        ["import:excel|key=apv_a", "import:excel|key=apv_b"]
          .map(getAccountColorRgbByImportNote)
          .filter((c): c is string => c != null)
      );
      return avg ?? undefined;
    }
    default:
      return undefined;
  }
}

export function attachColorRgbToAccountLines<
  T extends { account_id: number; color_rgb?: string },
>(lines: T[]): T[] {
  const resolved = lines.map((line) => {
    if (line.color_rgb) return line;
    const fromDb =
      line.account_id > 0
        ? colorRgbForTimeseriesAccountLine(line.account_id)
        : colorRgbForSyntheticAccountLine(line.account_id);
    return fromDb ? { ...line, color_rgb: fromDb } : line;
  });

  return resolved.map((line) => {
    if (line.color_rgb || line.account_id !== -1) return line;
    const childColors = resolved
      .filter((l) => l.account_id > 0 && l.color_rgb)
      .map((l) => l.color_rgb!);
    const avg = averageRgbTriplets(childColors);
    return avg ? { ...line, color_rgb: avg } : line;
  });
}

type TimeseriesAccountsBlock = {
  accounts?: { account_id: number; color_rgb?: string }[];
  points?: unknown;
  lines?: unknown;
  synthetic_group_color_rgb?: Record<string, string>;
};

export function attachColorsToTimeseriesBlock<T extends TimeseriesAccountsBlock | undefined>(
  block: T
): T {
  if (!block?.accounts?.length) return block;
  return { ...block, accounts: attachColorRgbToAccountLines(block.accounts) } as T;
}

export function attachColorsToValuationPayload<T extends Record<string, unknown>>(payload: T): T {
  const keys = [
    "accounts_in_group",
    "accounts_ex_property",
    "patrimonio_usd_milestones_chart",
    "accounts",
  ] as const;
  const out = { ...payload } as Record<string, unknown>;
  for (const key of keys) {
    const block = out[key];
    if (block && typeof block === "object" && "accounts" in block) {
      out[key] = attachColorsToTimeseriesBlock(block as TimeseriesAccountsBlock);
    }
  }
  return out as T;
}
