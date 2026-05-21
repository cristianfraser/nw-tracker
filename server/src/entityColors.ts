import {
  clearPortfolioGroupColorCache,
  getAccountColorRgb,
  normalizeColorRgbInput,
  resolvePortfolioGroupColorRgb,
  rgbTripletToCss,
} from "./chartColorRgb.js";
import { db } from "./db.js";

export type EntityColorPatchResult = { color_rgb: string | null; color: string };

export function updateAccountColorRgb(
  accountId: number,
  raw: unknown
): EntityColorPatchResult | null {
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(accountId) as { o: number } | undefined;
  if (!exists) return null;
  if (raw === null) {
    db.prepare(`UPDATE accounts SET color_rgb = NULL WHERE id = ?`).run(accountId);
    const resolved = getAccountColorRgb(accountId);
    return { color_rgb: null, color: rgbTripletToCss(resolved) };
  }
  const color_rgb = normalizeColorRgbInput(raw);
  if (!color_rgb) return null;
  db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(color_rgb, accountId);
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
    clearPortfolioGroupColorCache();
    const resolved = resolvePortfolioGroupColorRgb(row.id);
    return { color_rgb: null, color: rgbTripletToCss(resolved) };
  }
  const color_rgb = normalizeColorRgbInput(raw);
  if (!color_rgb) return null;
  db.prepare(`UPDATE portfolio_groups SET color_rgb = ? WHERE slug = ?`).run(color_rgb, slug);
  clearPortfolioGroupColorCache();
  return { color_rgb, color: rgbTripletToCss(color_rgb) };
}
