import { db } from "./db.js";
import { latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";

/** Stored as `r,g,b` integers 0–255. */
export type RgbTriplet = `${number},${number},${number}` | string;

export function parseRgbTriplet(raw: string | null | undefined): [number, number, number] | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function formatRgbTriplet(triplet: [number, number, number]): string {
  return `${triplet[0]},${triplet[1]},${triplet[2]}`;
}

/** Accept `r,g,b` or `#rgb` / `#rrggbb` for API color updates. */
export function normalizeColorRgbInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const triplet = parseRgbTriplet(s);
  if (triplet) return formatRgbTriplet(triplet);
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) return null;
  let h = hex[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  return formatRgbTriplet([r, g, b]);
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

const FALLBACK_GROUP_COLOR = "148,163,184";

function accountBalanceClp(accountId: number): number {
  const row = latestValuationRowOnOrBeforeChileToday(accountId);
  return row?.value_clp != null && Number.isFinite(row.value_clp) ? row.value_clp : 0;
}

/** Sum of latest balances for all accounts under a group (recursive). */
function totalBalanceClpUnderGroup(groupId: number, visiting = new Set<number>()): number {
  if (visiting.has(groupId)) return 0;
  visiting.add(groupId);
  const items = groupItemsStmt.all(groupId) as {
    item_kind: "group" | "account";
    child_group_id: number | null;
    account_id: number | null;
  }[];
  let sum = 0;
  for (const item of items) {
    if (item.item_kind === "account" && item.account_id != null) {
      sum += accountBalanceClp(item.account_id);
    } else if (item.item_kind === "group" && item.child_group_id != null) {
      sum += totalBalanceClpUnderGroup(item.child_group_id, visiting);
    }
  }
  return sum;
}

/**
 * Color of the direct child (subgroup or account) with the largest total balance.
 * Unset child groups resolve recursively.
 */
function groupColorFromLargestBalanceChild(groupId: number, visiting: Set<number>): string {
  const items = groupItemsStmt.all(groupId) as {
    item_kind: "group" | "account";
    child_group_id: number | null;
    account_id: number | null;
  }[];

  let bestBalance = -Infinity;
  let bestColor: string | null = null;

  for (const item of items) {
    if (item.item_kind === "account" && item.account_id != null) {
      const balance = accountBalanceClp(item.account_id);
      if (balance > bestBalance) {
        bestBalance = balance;
        bestColor = getAccountColorRgb(item.account_id);
      }
    } else if (item.item_kind === "group" && item.child_group_id != null) {
      const balance = totalBalanceClpUnderGroup(item.child_group_id);
      const color = resolvePortfolioGroupColorRgbInner(item.child_group_id, visiting);
      if (balance > bestBalance) {
        bestBalance = balance;
        bestColor = color;
      }
    }
  }

  return bestColor ?? FALLBACK_GROUP_COLOR;
}

function resolvePortfolioGroupColorRgbInner(groupId: number, visiting: Set<number>): string {
  if (visiting.has(groupId)) return FALLBACK_GROUP_COLOR;
  visiting.add(groupId);

  const group = db
    .prepare(`SELECT id, slug, color_rgb FROM portfolio_groups WHERE id = ?`)
    .get(groupId) as PortfolioGroupRow | undefined;
  if (!group) return FALLBACK_GROUP_COLOR;

  if (group.color_rgb) {
    resolvedGroupColorCache.set(groupId, group.color_rgb);
    return group.color_rgb;
  }

  return groupColorFromLargestBalanceChild(groupId, visiting);
}

/** Explicit group color, else color of the child group/account with the largest total balance (recursive). */
export function resolvePortfolioGroupColorRgb(groupId: number): string {
  const cached = resolvedGroupColorCache.get(groupId);
  if (cached) return cached;

  const resolved = resolvePortfolioGroupColorRgbInner(groupId, new Set());
  resolvedGroupColorCache.set(groupId, resolved);
  return resolved;
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

  for (const [idStr, portfolioSlug] of Object.entries(SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG)) {
    const accountId = Number(idStr);
    if (!Number.isFinite(accountId)) continue;
    const belongs =
      groupSlug === "brokerage"
        ? accountId >= -203 && accountId <= -201
        : groupSlug === "inversiones"
          ? accountId >= -615 && accountId <= -601
          : groupSlug === "retirement"
            ? accountId >= -704 && accountId <= -701
            : false;
    if (belongs) add(accountId, portfolioSlug);
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

/** Negative `account_id` on grouped valuation / performance charts → `portfolio_groups.slug`. */
export const SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG: Readonly<Record<number, string>> = {
  [-600]: "real_estate",
  [-201]: "brokerage_mutual_funds",
  [-202]: "brokerage_acciones",
  [-203]: "brokerage_crypto",
  [-601]: "brokerage",
  [-602]: "retirement",
  [-611]: "brokerage_mutual_funds",
  [-612]: "brokerage_acciones",
  [-613]: "brokerage_crypto",
  [-614]: "retirement_afp_afc",
  [-615]: "retirement_apv",
  [-701]: "retirement_afp_afc",
  [-702]: "retirement_apv",
  [-703]: "retirement_apv_a",
  [-704]: "retirement_apv_b",
  [-9101]: "retirement_afp_afc",
  [-9102]: "retirement_apv",
  [-9201]: "cash_eqs",
};

/** Synthetic grouped lines (brokerage / inversiones / retiro tabs, dashboard primary). */
export function colorRgbForSyntheticAccountLine(accountId: number): string | undefined {
  const slug = SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG[accountId];
  if (!slug) return undefined;
  return resolvePortfolioGroupColorRgbBySlug(slug) ?? undefined;
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
