import {
  clearPortfolioGroupColorCache,
  colorRgbOfLargestBalanceAccount,
  getAccountColorRgb,
  normalizeColorRgbInput,
  resolvePortfolioGroupColorRgb,
  rgbTripletToCss,
} from "./chartColorRgb.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";

/**
 * After a colour write: the page payloads carry colours baked in (chart lines, card pills, the nav
 * tree), and a group without a colour of its own takes its largest child's, so an account's colour
 * can change a group's. Colour writes are rare: drop the resolved group colours and every cached
 * payload, and let the warmer rebuild them.
 */
function colorsChanged(): void {
  clearPortfolioGroupColorCache();
  clearAggregationCache();
}

export type EntityColorPatchResult = { color_rgb: string | null; color: string };

export function updateAccountColorRgb(
  accountId: number,
  raw: unknown
): EntityColorPatchResult | null {
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(accountId) as { o: number } | undefined;
  if (!exists) return null;
  if (raw === null) {
    db.prepare(`UPDATE accounts SET color_rgb = NULL WHERE id = ?`).run(accountId);
    colorsChanged();
    const resolved = getAccountColorRgb(accountId);
    return { color_rgb: null, color: rgbTripletToCss(resolved) };
  }
  const color_rgb = normalizeColorRgbInput(raw);
  if (!color_rgb) return null;
  db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(color_rgb, accountId);
  colorsChanged();
  return { color_rgb, color: rgbTripletToCss(color_rgb) };
}

/** A Pasivos group's colour (`liability_groups.color_rgb`); null clears it back to its largest member's. */
export function updateLiabilityGroupColorRgb(slug: string, raw: unknown): EntityColorPatchResult | null {
  const row = db.prepare(`SELECT id FROM liability_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (!row) return null;
  if (raw === null) {
    db.prepare(`UPDATE liability_groups SET color_rgb = NULL WHERE slug = ?`).run(slug);
    colorsChanged();
    const members = db
      .prepare(`SELECT account_id FROM liability_group_items WHERE group_id = ? AND item_kind = 'account'`)
      .all(row.id) as { account_id: number }[];
    return { color_rgb: null, color: rgbTripletToCss(colorRgbOfLargestBalanceAccount(members.map((m) => m.account_id))) };
  }
  const color_rgb = normalizeColorRgbInput(raw);
  if (!color_rgb) return null;
  db.prepare(`UPDATE liability_groups SET color_rgb = ? WHERE slug = ?`).run(color_rgb, slug);
  colorsChanged();
  return { color_rgb, color: rgbTripletToCss(color_rgb) };
}

export function updatePortfolioGroupColorRgb(
  slug: string,
  raw: unknown
): EntityColorPatchResult | null {
  const row = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (!row) return null;
  if (raw === null) {
    db.prepare(`UPDATE portfolio_groups SET color_rgb = NULL WHERE slug = ?`).run(slug);
    colorsChanged();
    const resolved = resolvePortfolioGroupColorRgb(row.id);
    return { color_rgb: null, color: rgbTripletToCss(resolved) };
  }
  const color_rgb = normalizeColorRgbInput(raw);
  if (!color_rgb) return null;
  db.prepare(`UPDATE portfolio_groups SET color_rgb = ? WHERE slug = ?`).run(color_rgb, slug);
  colorsChanged();
  return { color_rgb, color: rgbTripletToCss(color_rgb) };
}
